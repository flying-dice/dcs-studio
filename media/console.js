// @ts-nocheck
// DCS Lua Console UI: two tabs over the two bridge connections (GUI bridge on
// 25569; mission bridge on 25570, only up during a mission), with a target
// environment picker (GUI/hooks, mission scripting env, or another net state).
// The host routes each call to the env's bridge.
//  Console  — send Lua via `eval`; results render here, `print` output from any
//             env streams in from the host's console_read poll.
//  Explorer — inspect an expression and drill into the resulting Lua tables
//             lazily; the {} button exports any table in full as JSON (the host
//             pops a save dialog).
(function () {
  const vscode = acquireVsCodeApi();
  const persisted = vscode.getState() || {};
  const history = persisted.history || [];
  let histIdx = history.length;
  let status = {
    gui: { connected: false, dcsTime: null },
    mission: { connected: false, dcsTime: null },
  };
  let env = persisted.env || "gui";
  let activeTab = persisted.tab || "console";

  const ENVS = [
    { id: "gui", label: "GUI (hooks)" },
    { id: "mission", label: "Mission (scripting env)" },
    { id: "server", label: "Server state" },
    { id: "config", label: "Config state" },
    { id: "export", label: "Export state" },
  ];

  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="status">
      <span class="dot off" id="dot"></span>
      <span class="label" id="statusLabel">Connecting…</span>
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
      <div class="input-row top">
        <input id="expr" placeholder="Lua expression…  e.g. _G  ·  Export  ·  env.mission (Mission env)" spellcheck="false" autocomplete="off" />
        <button class="btn" id="inspect">Inspect</button>
        <button class="btn secondary" id="clearTree" title="Clear the tree and release sim-side refs">Clear</button>
      </div>
      <div class="tree" id="tree">
        <div class="entry hint">Inspect an expression, then drill into tables. The <code>{}</code> button on a table exports it in full as JSON — e.g. inspect <code>env.mission</code> in the Mission env and export the whole mission DB.</div>
      </div>
    </div>
  `;

  const logEl = document.getElementById("log");
  const codeEl = document.getElementById("code");
  const runBtn = document.getElementById("run");
  const dot = document.getElementById("dot");
  const statusLabel = document.getElementById("statusLabel");
  const statusTime = document.getElementById("statusTime");
  const envWarn = document.getElementById("envWarn");
  const envSel = document.getElementById("envSel");
  const exprEl = document.getElementById("expr");
  const inspectBtn = document.getElementById("inspect");
  const clearTreeBtn = document.getElementById("clearTree");
  const treeEl = document.getElementById("tree");

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
    (name === "console" ? codeEl : exprEl).focus();
    persist();
  }
  for (const b of tabButtons) b.addEventListener("click", () => setTab(b.dataset.tab));

  // --- Console tab ---
  function append(cls, text) {
    const div = document.createElement("div");
    div.className = "entry " + cls;
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
    } else if (e.key === "ArrowDown" && codeEl.selectionStart === codeEl.value.length && history.length) {
      e.preventDefault();
      histIdx = Math.min(history.length, histIdx + 1);
      codeEl.value = history[histIdx] || "";
    }
  });

  // --- Explorer tab ---
  let seq = 0; // shared id counter for inspect/expand round trips
  let exportSeq = 0;
  const pendingExpand = new Map(); // nodeId -> { children, env, path }
  const pendingExport = new Map(); // reqId -> button
  const usedEnvs = new Set(); // envs holding live refs (for Clear)

  function treeMsg(cls, text) {
    const div = document.createElement("div");
    div.className = "entry " + cls;
    div.textContent = text;
    treeEl.appendChild(div);
    treeEl.scrollTop = treeEl.scrollHeight;
  }

  function exportNode(v, envName, path, btn) {
    const reqId = ++exportSeq;
    pendingExport.set(reqId, btn);
    btn.disabled = true;
    btn.textContent = "…";
    vscode.postMessage({
      type: "export",
      env: envName,
      // A live ref exports exactly the node on screen; a root without one
      // (or whose state was reset) re-evaluates its expression.
      ref: v.ref > 0 ? v.ref : undefined,
      expr: v.ref > 0 ? undefined : v.expr,
      label: path,
      reqId,
    });
  }

  // One tree node. `v` = {name, type, value, ref, expr?}; `path` is the
  // human-readable chain (root expr + child names) used to label exports.
  function makeNode(v, envName, path) {
    const node = document.createElement("div");
    node.className = "node";
    const row = document.createElement("div");
    row.className = "row" + (v.ref > 0 ? " expandable" : "");
    const twisty = document.createElement("span");
    twisty.className = "twisty";
    twisty.textContent = v.ref > 0 ? "▸" : "";
    row.appendChild(twisty);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = v.name;
    row.appendChild(name);
    const preview = document.createElement("span");
    preview.className = "preview t-" + v.type;
    preview.textContent = v.value;
    row.appendChild(preview);
    if (v.type === "table" && (v.ref > 0 || v.expr)) {
      const btn = document.createElement("button");
      btn.className = "mini";
      btn.textContent = "{}";
      btn.title = "Export this table as JSON";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        exportNode(v, envName, path, btn);
      });
      row.appendChild(btn);
    }
    const children = document.createElement("div");
    children.className = "children";
    children.style.display = "none";
    node.appendChild(row);
    node.appendChild(children);

    let loaded = false;
    let open = false;
    row.addEventListener("click", () => {
      if (!(v.ref > 0)) return;
      open = !open;
      twisty.textContent = open ? "▾" : "▸";
      children.style.display = open ? "" : "none";
      if (open && !loaded) {
        loaded = true;
        const nodeId = ++seq;
        pendingExpand.set(nodeId, { children, env: envName, path });
        vscode.postMessage({ type: "expand", env: envName, ref: v.ref, nodeId });
      }
    });
    return node;
  }

  function doInspect() {
    const expr = exprEl.value.trim();
    if (!expr) return;
    vscode.postMessage({ type: "inspect", env, expr, id: ++seq });
  }

  inspectBtn.addEventListener("click", doInspect);
  exprEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doInspect();
    }
  });

  clearTreeBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "clearExplorer", envs: Array.from(usedEnvs) });
    usedEnvs.clear();
    pendingExpand.clear();
    treeEl.innerHTML = "";
  });

  // --- Status line (two bridges: gui always up with DCS, mission only during a mission) ---
  function renderStatus() {
    const gui = status.gui || { connected: false, dcsTime: null };
    const mission = status.mission || { connected: false, dcsTime: null };
    const simTime = mission.connected && mission.dcsTime != null ? mission.dcsTime : gui.dcsTime;
    let offline = false;
    if (!gui.connected && !mission.connected) {
      dot.className = "dot off";
      statusLabel.textContent = "Bridge offline — start DCS (or Inject + restart it)";
      statusTime.textContent = "";
      offline = true;
    } else if (mission.connected) {
      dot.className = "dot mission";
      statusLabel.textContent = "Mission running";
      statusTime.textContent = simTime > 0 ? "sim t = " + simTime.toFixed(1) + "s" : "";
    } else if (gui.dcsTime > 0) {
      dot.className = "dot menu";
      statusLabel.textContent = "Mission running — mission bridge offline";
      statusTime.textContent = "sim t = " + gui.dcsTime.toFixed(1) + "s";
    } else {
      dot.className = "dot menu";
      statusLabel.textContent = "Connected — at menu (no mission)";
      statusTime.textContent = "";
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
    const envDown = env === "mission" ? !mission.connected : !gui.connected;
    runBtn.disabled = offline || envDown;
    inspectBtn.disabled = offline || envDown;
  }
  renderStatus();
  setTab(activeTab);

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m) return;
    switch (m.type) {
      case "status":
        status = m.status;
        renderStatus();
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
      case "inspectResult": {
        if (!m.ok) {
          treeMsg("error", m.expr + " — " + (m.err || "error"));
          break;
        }
        usedEnvs.add(m.env);
        const root = makeNode(
          { name: m.expr, type: m.type, value: m.value, ref: m.ref, expr: m.expr },
          m.env,
          m.expr,
        );
        root.classList.add("root");
        treeEl.appendChild(root);
        treeEl.scrollTop = treeEl.scrollHeight;
        break;
      }
      case "expandResult": {
        const p = pendingExpand.get(m.nodeId);
        if (!p) break;
        pendingExpand.delete(m.nodeId);
        if (!m.ok) {
          const err = document.createElement("div");
          err.className = "entry error";
          err.textContent = m.err || "expand failed";
          p.children.appendChild(err);
          break;
        }
        if (!m.variables.length) {
          const empty = document.createElement("div");
          empty.className = "entry hint";
          empty.textContent = "(empty)";
          p.children.appendChild(empty);
          break;
        }
        for (const v of m.variables) {
          p.children.appendChild(makeNode(v, p.env, p.path + "." + v.name));
        }
        break;
      }
      case "exportDone": {
        const btn = pendingExport.get(m.reqId);
        pendingExport.delete(m.reqId);
        if (btn) {
          btn.disabled = false;
          btn.textContent = "{}";
        }
        if (m.error) treeMsg("error", "export failed — " + m.error);
        break;
      }
    }
  });
})();
