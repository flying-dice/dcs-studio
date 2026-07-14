// @ts-nocheck
// DCS Lua Console UI: two tabs over the two bridge connections (GUI bridge on
// 25569; mission bridge on 25570, only up during a mission), with a target
// environment picker (GUI/hooks, mission scripting env, or another net state).
// The host routes each call to the env's bridge.
//  Console  — send Lua via `eval`; results render here, `print` output from any
//             env streams in from the host's console_read poll.
//  Explorer — a single lazy `_G` tree per env (dcsfiddle-style): type icons,
//             function arity previews with click-to-resolve real parameter
//             names (repl_signature — never calls the function), a three-mode
//             live filter that keeps ancestors of deep matches visible, an
//             Enter-triggered budget-capped sweep over `/`-path patterns,
//             per-node copy-children-as-JSON, and full-table JSON export. Pure
//             logic (glob/filter/sweep/copy) lives in explorer-core.js
//             (DcsExplorerCore), loaded before this script.
(function () {
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
  let wildcardDepth = 1; // `**` cost for the sweep; pushed by the host `config` msg

  const ENVS = [
    { id: "gui", label: "GUI (hooks)" },
    { id: "mission", label: "Mission (scripting env)" },
    { id: "server", label: "Server state" },
    { id: "config", label: "Config state" },
    { id: "export", label: "Export state" },
  ];

  let launching = false;
  let launchTimer = null;

  // ── Inline Lucide-style icons (paths only; wrapped by svg()) ──
  const ICON = {
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    loader:
      '<line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.9" y1="4.9" x2="7.8" y2="7.8"/><line x1="16.2" y1="16.2" x2="19.1" y2="19.1"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.9" y1="19.1" x2="7.8" y2="16.2"/><line x1="16.2" y1="7.8" x2="19.1" y2="4.9"/>',
    hash: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
    func: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 17c2 0 2.8-1 2.8-2.8V10c0-2 1-3.3 3.2-3"/><path d="M9 11.2h5.7"/>',
    toggle: '<rect width="20" height="12" x="2" y="6" rx="6"/><circle cx="8" cy="12" r="2"/>',
    type: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
    box: '<path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    listTree:
      '<path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/>',
    refresh:
      '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  };
  function svg(name, cls) {
    return (
      '<svg class="ic' +
      (cls ? " " + cls : "") +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      ICON[name] +
      "</svg>"
    );
  }

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
    showEnvTree();
    ensureInspected();
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
      showEnvTree();
      ensureInspected();
    }
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
  // Per-env state: the cached root node and its DOM container (display-toggled
  // so switching env keeps each tree — and its live sim-side refs — intact).
  let seq = 0; // shared id counter for inspect/expand/signature/export round trips
  const trees = {}; // env -> root node (or absent = not inspected)
  const inspected = {}; // env -> true once an inspect has been dispatched
  const envContainers = {}; // env -> tree container div
  const pendingInspect = new Map(); // id -> env
  const pendingExpand = new Map(); // nodeId -> { node, then? }
  const pendingSignature = new Map(); // reqId -> node
  const pendingExport = new Map(); // reqId -> button
  let sweepGen = 0; // bumped to cancel an in-flight sweep (filter edit / new sweep)
  let filterTimer = null;

  function explorerDisabled() {
    const gui = status.gui || {};
    const mission = status.mission || {};
    if (!gui.connected && !mission.connected) return true;
    return env === "mission" ? !mission.connected : !gui.connected;
  }

  function ensureContainer(envName) {
    let c = envContainers[envName];
    if (!c) {
      c = document.createElement("div");
      c.className = "tree-env";
      c.dataset.env = envName;
      c.style.display = "none";
      treeHost.appendChild(c);
      envContainers[envName] = c;
    }
    return c;
  }

  function showEnvTree() {
    for (const e of ENVS) {
      const c = envContainers[e.id];
      if (c) c.style.display = e.id === env ? "" : "none";
    }
    ensureContainer(env).style.display = "";
    applyFilter();
  }

  // Post the one-and-only inspect for an env's `_G` root (first show, or after
  // Refresh). Guarded by connectivity and the per-env `inspected` flag.
  function ensureInspected() {
    if (activeTab !== "explorer" || explorerDisabled() || inspected[env]) return;
    inspected[env] = true;
    const id = ++seq;
    pendingInspect.set(id, env);
    vscode.postMessage({ type: "inspect", env, expr: "_G", id });
  }

  function iconName(node) {
    if (node.loading) return "loader";
    switch (node.type) {
      case "table":
        return node.open ? "chevronDown" : "chevronRight";
      case "function":
        return "func";
      case "number":
        return "hash";
      case "boolean":
        return "toggle";
      case "string":
        return "type";
      default:
        return "box";
    }
  }

  function updateToggleIcon(node) {
    node.el.toggle.innerHTML = svg(iconName(node), node.loading ? "spin" : "");
    node.el.toggle.disabled = !((node.type === "table" || node.type === "function") && node.ref > 0);
  }

  function makeNode(v, envName) {
    const node = {
      key: v.key,
      path: v.path,
      depth: v.depth,
      type: v.type,
      value: v.value,
      ref: v.ref,
      env: envName,
      open: false,
      loaded: false,
      loading: false,
      children: null,
      matched: true,
      signature: null,
      el: {},
    };
    const nodeEl = document.createElement("div");
    nodeEl.className = "node";
    nodeEl.dataset.path = v.path;
    nodeEl.setAttribute("data-testid", "tree-node");
    const row = document.createElement("div");
    row.className = "row";
    const toggle = document.createElement("button");
    toggle.className = "toggle";
    toggle.setAttribute("data-testid", "node-toggle");
    row.appendChild(toggle);
    const key = document.createElement("span");
    key.className = "key";
    key.textContent = v.key;
    row.appendChild(key);
    const preview = document.createElement("span");
    preview.className = "preview t-" + v.type;
    preview.setAttribute("data-testid", "node-preview");
    preview.textContent = v.value;
    row.appendChild(preview);
    node.el.preview = preview;
    if (v.type === "table") {
      const copyBtn = document.createElement("button");
      copyBtn.className = "icon-btn copy";
      copyBtn.setAttribute("data-testid", "node-copy");
      copyBtn.title = "Copy children as JSON";
      copyBtn.innerHTML = svg("copy");
      copyBtn.disabled = true;
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        copyNode(node);
      });
      row.appendChild(copyBtn);
      node.el.copy = copyBtn;
      const exportBtn = document.createElement("button");
      exportBtn.className = "icon-btn export";
      exportBtn.setAttribute("data-testid", "node-export");
      exportBtn.title = "Export this table as a JSON file";
      exportBtn.innerHTML = svg("download");
      exportBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        exportNode(node, exportBtn);
      });
      row.appendChild(exportBtn);
      node.el.export = exportBtn;
    }
    const children = document.createElement("div");
    children.className = "children";
    children.style.display = "none";
    nodeEl.appendChild(row);
    nodeEl.appendChild(children);
    node.el.node = nodeEl;
    node.el.row = row;
    node.el.toggle = toggle;
    node.el.children = children;
    row.addEventListener("click", () => onToggle(node));
    updateToggleIcon(node);
    return node;
  }

  function onToggle(node) {
    if (node.type === "table" && node.ref > 0) {
      if (node.open) closeTable(node);
      else openTable(node);
    } else if (node.type === "function" && node.ref > 0) {
      resolveSignature(node);
    }
  }

  // Open + fetch a table's children. `then` (optional) is the sweep drain
  // continuation, invoked with the freshly attached children.
  function openTable(node, then) {
    node.open = true;
    node.loading = true;
    node.el.children.style.display = "";
    updateToggleIcon(node);
    const nodeId = ++seq;
    pendingExpand.set(nodeId, { node, then });
    vscode.postMessage({ type: "expand", env: node.env, ref: node.ref, nodeId });
  }

  // Collapse discards children (fiddle parity): the next open refetches, so a
  // stale sim-side ref self-heals.
  function closeTable(node) {
    node.open = false;
    node.loaded = false;
    node.children = null;
    node.el.children.innerHTML = "";
    node.el.children.style.display = "none";
    if (node.el.copy) node.el.copy.disabled = true;
    updateToggleIcon(node);
  }

  function resolveSignature(node) {
    if (node.signature || node.loading) return;
    node.loading = true;
    updateToggleIcon(node);
    const reqId = ++seq;
    pendingSignature.set(reqId, node);
    vscode.postMessage({ type: "signature", env: node.env, ref: node.ref, reqId });
  }

  function copyNode(node) {
    const text = JSON.stringify(core.childrenToJson(node), null, 2);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
    } catch {
      /* clipboard may be unavailable; the check icon still confirms the attempt */
    }
    const btn = node.el.copy;
    btn.innerHTML = svg("check");
    btn.classList.add("copied");
    btn.setAttribute("data-state", "copied");
    clearTimeout(btn._t);
    btn._t = setTimeout(() => {
      btn.innerHTML = svg("copy");
      btn.classList.remove("copied");
      btn.removeAttribute("data-state");
    }, 2000);
  }

  function exportNode(node, btn) {
    const reqId = ++seq;
    pendingExport.set(reqId, btn);
    btn.disabled = true;
    vscode.postMessage({
      type: "export",
      env: node.env,
      ref: node.ref > 0 ? node.ref : undefined,
      expr: node.ref > 0 ? undefined : node.path,
      label: node.path,
      reqId,
    });
  }

  function walk(node, fn) {
    fn(node);
    if (node.children) for (const c of node.children) walk(c, fn);
  }

  // Debounced live filter: annotate the whole tree then toggle `.hidden` per
  // node (kept mounted). Ancestors of a deep match stay visible via the core's
  // upward match propagation. An empty filter unhides everything.
  function applyFilter() {
    const root = trees[env];
    updateSweepEnabled();
    if (!root) return;
    const filter = filterInput.value.trim();
    core.annotateMatches(root, filter);
    walk(root, (n) => n.el.node.classList.toggle("hidden", !n.matched));
  }

  function updateSweepEnabled() {
    sweepBtn.disabled = explorerDisabled() || !core.canSweep(filterInput.value.trim());
  }

  function showNotice(text) {
    sweepNotice.textContent = text;
    sweepNotice.style.display = "";
  }
  function clearNotice() {
    sweepNotice.textContent = "";
    sweepNotice.style.display = "none";
  }

  // Enter-triggered sweep: auto-expand closed table nodes lying on the path
  // toward a match, bounded by a 200-fetch budget and the wildcard depth.
  // Concurrency 1 (the sim thread is single-threaded; the mission mailbox is
  // one slot); a filter edit or a new sweep bumps the generation to cancel.
  function sweep() {
    const filter = filterInput.value.trim();
    if (!core.canSweep(filter)) {
      showNotice("Use a path pattern with / to sweep — e.g. _G/db/Units/*.");
      return;
    }
    const root = trees[env];
    if (!root || explorerDisabled()) return;
    const gen = ++sweepGen;
    const maxDepth = core.sweepMaxDepth(filter, wildcardDepth);
    let spent = 0;
    const queue = [];
    const seedFrom = (node) => {
      if (
        node.type === "table" &&
        node.ref > 0 &&
        !node.open &&
        core.shouldSweepFetch(node.path, node.depth, filter, maxDepth)
      ) {
        queue.push(node);
      }
      if (node.children) for (const c of node.children) seedFrom(c);
    };
    seedFrom(root);
    if (env === "mission") showNotice("Mission sweep can be slow — each fetch waits on the sim thread.");
    else clearNotice();
    const drain = () => {
      if (gen !== sweepGen) return; // superseded
      if (spent >= core.SWEEP_BUDGET) {
        showNotice("Sweep hit the " + core.SWEEP_BUDGET + "-fetch limit — refine the pattern.");
        applyFilter();
        return;
      }
      if (!queue.length) {
        applyFilter();
        if (env !== "mission") clearNotice();
        return;
      }
      const node = queue.shift();
      spent++;
      openTable(node, (children) => {
        if (gen !== sweepGen) return;
        for (const c of children) {
          if (
            c.type === "table" &&
            c.ref > 0 &&
            !c.open &&
            core.shouldSweepFetch(c.path, c.depth, filter, maxDepth)
          ) {
            queue.push(c);
          }
        }
        drain();
      });
    };
    drain();
  }

  filterInput.addEventListener("input", () => {
    // A filter edit cancels any in-flight sweep.
    sweepGen++;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(applyFilter, 100);
  });
  filterInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sweep();
    }
  });
  sweepBtn.addEventListener("click", sweep);
  refreshBtn.addEventListener("click", () => {
    if (explorerDisabled()) return;
    vscode.postMessage({ type: "clearExplorer", envs: [env] });
    trees[env] = null;
    inspected[env] = false;
    const c = envContainers[env];
    if (c) c.innerHTML = "";
    clearNotice();
    ensureInspected();
  });

  // --- Status line (two bridges: gui always up with DCS, mission only during a mission) ---
  function renderStatus() {
    const gui = status.gui || { connected: false, dcsTime: null };
    const mission = status.mission || { connected: false, dcsTime: null };
    const simTime = mission.connected && mission.dcsTime != null ? mission.dcsTime : gui.dcsTime;
    let offline = false;
    if (!gui.connected && !mission.connected) {
      dot.className = "dot off";
      statusLabel.textContent = "Bridge offline — click Launch DCS (with bridge) to connect";
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
    const disabled = explorerDisabled();
    runBtn.disabled = offline || (env === "mission" ? !mission.connected : !gui.connected);
    filterInput.disabled = disabled;
    refreshBtn.disabled = disabled;
    updateSweepEnabled();
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m) return;
    switch (m.type) {
      case "status":
        status = m.status;
        renderStatus();
        ensureInspected();
        break;
      case "config":
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
      case "inspectResult": {
        const rEnv = pendingInspect.get(m.id) || m.env;
        pendingInspect.delete(m.id);
        const container = ensureContainer(rEnv);
        container.innerHTML = "";
        if (!m.ok) {
          inspected[rEnv] = false; // allow a retry
          const err = document.createElement("div");
          err.className = "entry error";
          err.textContent = (m.expr || "_G") + " — " + (m.err || "error");
          container.appendChild(err);
          break;
        }
        const root = makeNode(
          { key: m.expr || "_G", path: "_G", depth: 0, type: m.luaType, value: m.value, ref: m.ref },
          rEnv,
        );
        root.el.node.classList.add("root");
        trees[rEnv] = root;
        container.appendChild(root.el.node);
        // Auto-expand the root so the top-level keys show immediately.
        if (root.type === "table" && root.ref > 0) openTable(root);
        if (rEnv === env) applyFilter();
        break;
      }
      case "expandResult": {
        const p = pendingExpand.get(m.nodeId);
        if (!p) break;
        pendingExpand.delete(m.nodeId);
        const node = p.node;
        node.loading = false;
        if (!m.ok) {
          updateToggleIcon(node);
          const err = document.createElement("div");
          err.className = "entry error";
          err.textContent = m.err || "expand failed";
          node.el.children.appendChild(err);
          if (p.then) p.then([]);
          break;
        }
        node.loaded = true;
        node.children = (m.variables || []).map((v) =>
          makeNode(
            { key: v.name, path: core.childPath(node.path, v.name), depth: node.depth + 1, type: v.type, value: v.value, ref: v.ref },
            node.env,
          ),
        );
        node.el.children.innerHTML = "";
        for (const c of node.children) node.el.children.appendChild(c.el.node);
        if (!node.children.length) {
          const empty = document.createElement("div");
          empty.className = "entry hint";
          empty.textContent = "(empty)";
          node.el.children.appendChild(empty);
        }
        if (node.el.copy) node.el.copy.disabled = false;
        updateToggleIcon(node);
        if (node.env === env) applyFilter();
        if (p.then) p.then(node.children);
        break;
      }
      case "signatureResult": {
        const node = pendingSignature.get(m.reqId);
        if (!node) break;
        pendingSignature.delete(m.reqId);
        node.loading = false;
        updateToggleIcon(node);
        if (m.ok) {
          node.signature = core.signatureDisplay(node.key, m.params || "");
          node.el.preview.textContent = m.native ? node.signature + "  (native)" : node.signature;
          node.el.preview.classList.remove("sig-error");
        } else {
          node.el.preview.textContent = m.err || "signature unavailable";
          node.el.preview.classList.add("sig-error");
        }
        break;
      }
      case "exportDone": {
        const btn = pendingExport.get(m.reqId);
        pendingExport.delete(m.reqId);
        if (btn) btn.disabled = false;
        if (m.error) showNotice("export failed — " + m.error);
        break;
      }
    }
  });

  renderStatus();
  setTab(activeTab);
  // Ask the host to (re)push status + config now that our listener is attached.
  vscode.postMessage({ type: "ready" });
})();
