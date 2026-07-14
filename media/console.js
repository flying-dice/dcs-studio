// @ts-nocheck
// DCS Lua Console UI: two tabs over the two bridge connections (GUI bridge on
// 25569; mission bridge on 25570, only up during a mission), with a target
// environment picker (GUI/hooks, mission scripting env, or another net state).
// The host routes each call to the env's bridge.
//  Console  — send Lua via `eval`; results render here, `print` output from any
//             env streams in from the host's console_read poll.
//  Explorer — a lazy `_G` tree per env; its DOM + interaction live in
//             console-explorer.js (DcsConsoleExplorer), loaded before this
//             script, with the pure glob/filter/sweep/copy logic in
//             explorer-core.js (DcsExplorerCore). This file owns the Console
//             REPL tab, the shared status line and the message router; the
//             router delegates the tree round-trip replies to the explorer.
(() => {
  const vscode = acquireVsCodeApi();
  const core = window.DcsExplorerCore;
  const persisted = vscode.getState() || {};
  const history = persisted.history || [];
  let histIdx = history.length;
  let status = {
    gui: { connected: false, dcsTime: null },
    mission: { connected: false, dcsTime: null },
  };
  let env = persisted.env || "gui";
  let activeTab = persisted.tab || "console";
  let wildcardDepth = 1; // `**` cost for the sweep; pushed by the host `explorerConfig` msg

  const ENVS = [
    { id: "gui", label: "GUI (hooks)" },
    { id: "mission", label: "Mission (scripting env)" },
    { id: "server", label: "Server state" },
    { id: "config", label: "Config state" },
    { id: "export", label: "Export state" },
  ];

  let launching = false;
  let launchTimer = null;

  const svg = window.DcsConsoleExplorer.svg;

  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="status">
      <span class="dot off" id="dot"></span>
      <span class="label" id="statusLabel">Connecting…</span>
      <button class="btn launch" id="launchBtn" style="display:none">Launch DCS (with bridge)</button>
      <span class="warn" id="envWarn"></span>
      <select id="envSel" title="Environment Lua runs in"></select>
      <span class="time" id="statusTime"></span>
    </div>
    <div class="tabs">
      <button class="tab" data-tab="console">Console</button>
      <button class="tab" data-tab="explorer">Explorer</button>
    </div>
    <div class="view" id="view-console">
      <div class="log" id="log">
        <div class="entry hint">Runs in the environment picked above — GUI (hooks; full DCS.*/net.*) or the mission scripting env (coalition/world/trigger; needs a running mission). Try <code>return DCS.getVersion()</code> (GUI) or <code>return #world.getAirbases()</code> (Mission). Ctrl/⌘+Enter to run.</div>
      </div>
      <div class="input-row">
        <textarea id="code" placeholder="Lua…  (Ctrl/⌘+Enter to run, ↑/↓ history)" spellcheck="false" autocomplete="off"></textarea>
        <button class="btn" id="run">Run<span class="kbd">⌘⏎</span></button>
      </div>
    </div>
    <div class="view" id="view-explorer">
      <div class="explorer-toolbar">
        <div class="filter-wrap">
          <span class="filter-icon">${svg("search")}</span>
          <input id="explorerFilter" data-testid="explorer-filter" spellcheck="false" autocomplete="off"
            placeholder="Filter, e.g. */db/Units/* — Enter sweeps path patterns (glob: * ? **, no [] or {})" />
        </div>
        <button class="icon-btn" id="sweepBtn" data-testid="sweep-btn" title="Sweep the path pattern (Enter): auto-expand toward matches">${svg("listTree")}</button>
        <button class="icon-btn" id="refreshBtn" data-testid="refresh-btn" title="Refresh: release sim-side refs and re-read _G">${svg("refresh")}</button>
      </div>
      <div class="sweep-notice" id="sweepNotice" data-testid="sweep-notice" style="display:none"></div>
      <div class="tree" id="treeHost"></div>
    </div>
  `;

  const logEl = document.getElementById("log");
  const codeEl = document.getElementById("code");
  const runBtn = document.getElementById("run");
  const dot = document.getElementById("dot");
  const statusLabel = document.getElementById("statusLabel");
  const launchBtn = document.getElementById("launchBtn");
  const statusTime = document.getElementById("statusTime");
  const envWarn = document.getElementById("envWarn");
  const envSel = document.getElementById("envSel");
  const filterInput = document.getElementById("explorerFilter");
  const sweepBtn = document.getElementById("sweepBtn");
  const refreshBtn = document.getElementById("refreshBtn");
  const sweepNotice = document.getElementById("sweepNotice");
  const treeHost = document.getElementById("treeHost");

  // The Explorer tab controller reads live env/status/config through these
  // getters (this shell owns and mutates them) and owns all tree DOM/interaction.
  const explorer = window.DcsConsoleExplorer.create({
    vscode,
    core,
    els: { treeHost, filterInput, sweepBtn, refreshBtn, sweepNotice },
    ENVS,
    getEnv: () => env,
    getStatus: () => status,
    getWildcardDepth: () => wildcardDepth,
    getActiveTab: () => activeTab,
  });

  for (const e of ENVS) {
    const opt = document.createElement("option");
    opt.value = e.id;
    opt.textContent = e.label;
    envSel.appendChild(opt);
  }
  envSel.value = env;
  envSel.addEventListener("change", () => {
    env = envSel.value;
    persist();
    renderStatus();
    explorer.showEnvTree();
    explorer.ensureInspected();
  });

  // Offline CTA: funnels into the same dcs.bridge.launch command as the
  // status bar and Command Palette. No completion signal comes back over
  // this channel, so "launching" is a local guard that clears itself either
  // when a status push shows we're online (renderStatus) or after a timeout
  // (a failed launch — e.g. a precondition error toast — leaves us offline).
  launchBtn.addEventListener("click", () => {
    launching = true;
    renderStatus();
    vscode.postMessage({ type: "launch" });
    clearTimeout(launchTimer);
    launchTimer = setTimeout(() => {
      launching = false;
      renderStatus();
    }, 15000);
  });

  function persist() {
    vscode.setState({ history, env, tab: activeTab });
  }

  // --- Tabs ---
  const tabButtons = Array.from(document.querySelectorAll(".tab"));
  function setTab(name) {
    activeTab = name;
    for (const b of tabButtons) b.classList.toggle("active", b.dataset.tab === name);
    document.getElementById("view-console").classList.toggle("active", name === "console");
    document.getElementById("view-explorer").classList.toggle("active", name === "explorer");
    if (name === "console") codeEl.focus();
    else {
      filterInput.focus();
      explorer.showEnvTree();
      explorer.ensureInspected();
    }
    persist();
  }
  for (const b of tabButtons) b.addEventListener("click", () => setTab(b.dataset.tab));

  // --- Console tab ---
  function append(cls, text) {
    const div = document.createElement("div");
    div.className = `entry ${cls}`;
    div.textContent = text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function fmtValue(v) {
    if (v === null || v === undefined) return "nil";
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }

  function run() {
    const code = codeEl.value.trim();
    if (!code) return;
    append("input", code);
    if (history[history.length - 1] !== code) history.push(code);
    if (history.length > 100) history.shift();
    persist();
    histIdx = history.length;
    codeEl.value = "";
    vscode.postMessage({ type: "eval", env, code });
  }

  runBtn.addEventListener("click", run);
  codeEl.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      run();
    } else if (e.key === "ArrowUp" && codeEl.selectionStart === 0 && history.length) {
      e.preventDefault();
      histIdx = Math.max(0, histIdx - 1);
      codeEl.value = history[histIdx] || "";
    } else if (
      e.key === "ArrowDown" &&
      codeEl.selectionStart === codeEl.value.length &&
      history.length
    ) {
      e.preventDefault();
      histIdx = Math.min(history.length, histIdx + 1);
      codeEl.value = history[histIdx] || "";
    }
  });

  // --- Status line (two bridges: gui always up with DCS, mission only during a mission) ---
  function renderStatus() {
    const gui = status.gui || { connected: false, dcsTime: null };
    const mission = status.mission || { connected: false, dcsTime: null };
    const simTime = mission.connected && mission.dcsTime != null ? mission.dcsTime : gui.dcsTime;
    const anyConnected = gui.connected || mission.connected;
    // A live mission (mission bridge up) is the "mission" dot; any other
    // connected state is "menu". Labels/time stay bespoke to this surface.
    dot.className = dcsUi.bridgeDotClass(anyConnected, mission.connected);
    let offline = false;
    if (!anyConnected) {
      statusLabel.textContent = "Bridge offline — click Launch DCS (with bridge) to connect";
      statusTime.textContent = "";
      offline = true;
    } else if (mission.connected) {
      statusLabel.textContent = "Mission running";
      statusTime.textContent = simTime > 0 ? `sim t = ${simTime.toFixed(1)}s` : "";
    } else if (gui.dcsTime > 0) {
      statusLabel.textContent = "Mission running — mission bridge offline";
      statusTime.textContent = `sim t = ${gui.dcsTime.toFixed(1)}s`;
    } else {
      statusLabel.textContent = "Connected — at menu (no mission)";
      statusTime.textContent = "";
    }
    // The launch CTA only makes sense while fully offline; once either
    // bridge answers, drop the local "launching" guard too so a later
    // disconnect starts the button fresh (not stuck disabled).
    if (offline) {
      launchBtn.style.display = "";
      launchBtn.disabled = launching;
      launchBtn.textContent = launching ? "Launching…" : "Launch DCS (with bridge)";
    } else {
      launchBtn.style.display = "none";
      if (launching) {
        launching = false;
        clearTimeout(launchTimer);
      }
    }
    // The selected env's bridge drives the warning and the buttons.
    let warn = "";
    if (env === "mission" && !mission.connected) {
      warn =
        gui.dcsTime > 0
          ? "mission bridge offline — desanitize MissionScripting.lua and restart the mission"
          : "needs a running mission";
    } else if (env !== "mission" && !gui.connected) {
      warn = "GUI bridge offline";
    }
    envWarn.textContent = warn;
    const disabled = explorer.isDisabled();
    runBtn.disabled = offline || (env === "mission" ? !mission.connected : !gui.connected);
    filterInput.disabled = disabled;
    refreshBtn.disabled = disabled;
    explorer.updateSweepEnabled();
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m) return;
    switch (m.type) {
      case "status":
        status = m.status;
        renderStatus();
        explorer.ensureInspected();
        break;
      case "explorerConfig":
        if (typeof m.wildcardDepth === "number") wildcardDepth = m.wildcardDepth;
        break;
      case "result":
        append("result", fmtValue(m.value));
        break;
      case "error":
        append("error", m.message);
        break;
      case "print":
        for (const line of m.lines) append("print", line.text);
        break;
      // Explorer tree round-trips are owned by the Explorer controller.
      case "inspectResult":
      case "expandResult":
      case "signatureResult":
      case "exportDone":
        explorer.handleMessage(m);
        break;
    }
  });

  renderStatus();
  setTab(activeTab);
  // Ask the host to (re)push status + config now that our listener is attached.
  vscode.postMessage({ type: "ready" });
})();
