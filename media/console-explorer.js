// @ts-nocheck
// The Lua Console's Explorer tab: the dcsfiddle-style lazy `_G` tree — DOM
// construction, per-env tree state, the live filter, the Enter-triggered sweep,
// copy-as-JSON and full-table export. Split out of console.js (which keeps the
// Console REPL tab, the status line and the message router). Pure logic
// (glob/filter/sweep/copy) still lives in explorer-core.js (DcsExplorerCore);
// this module owns only the DOM + interaction.
//
// `DcsConsoleExplorer.svg(name, cls)` renders one inline icon (also used by
// console.js for the toolbar). `DcsConsoleExplorer.create(ctx)` builds a
// controller bound to the shared context: it reads live env/status/config via
// the ctx getters (console.js owns those) and returns the handful of methods
// the console shell drives — showEnvTree, ensureInspected, applyFilter,
// updateSweepEnabled, isDisabled and handleMessage (the router delegates the
// tree round-trip replies here).
(() => {
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
    refresh: dcsUi.iconPaths.refresh,
    download: dcsUi.iconPaths.download,
  };
  function svg(name, cls) {
    return (
      '<svg class="ic' +
      (cls ? ` ${cls}` : "") +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      ICON[name] +
      "</svg>"
    );
  }

  // Build the Explorer controller. `ctx`:
  //   vscode, core                — the API bridge + DcsExplorerCore
  //   els: { treeHost, filterInput, sweepBtn, refreshBtn, sweepNotice }
  //   ENVS                        — the env descriptor list (for showEnvTree)
  //   getEnv / getStatus / getWildcardDepth / getActiveTab — live reads of the
  //     console shell's state (it owns those and mutates them).
  function create(ctx) {
    const { vscode, core, ENVS } = ctx;
    const { treeHost, filterInput, sweepBtn, refreshBtn, sweepNotice } = ctx.els;
    const env = () => ctx.getEnv();

    // Per-env state: the cached root node and its DOM container (display-toggled
    // so switching env keeps each tree — and its live sim-side refs — intact).
    let seq = 0; // shared id counter for inspect/expand/signature/export round trips
    const trees = {}; // env -> root node (or absent = not inspected)
    const inspected = {}; // env -> true once an inspect has been dispatched
    const envContainers = {}; // env -> tree container div
    const pendingInspect = new Map(); // id -> env
    const pendingExpand = new Map(); // nodeId -> { node, onChildren? }
    const pendingSignature = new Map(); // reqId -> node
    const pendingExport = new Map(); // reqId -> button
    let sweepGen = 0; // bumped to cancel an in-flight sweep (filter edit / new sweep)
    let filterTimer = null;

    function explorerDisabled() {
      const status = ctx.getStatus();
      const gui = status.gui || {};
      const mission = status.mission || {};
      if (!gui.connected && !mission.connected) return true;
      return env() === "mission" ? !mission.connected : !gui.connected;
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
        if (c) c.style.display = e.id === env() ? "" : "none";
      }
      ensureContainer(env()).style.display = "";
      applyFilter();
    }

    // Post the one-and-only inspect for an env's `_G` root (first show, or after
    // Refresh). Guarded by connectivity and the per-env `inspected` flag.
    function ensureInspected() {
      if (ctx.getActiveTab() !== "explorer" || explorerDisabled() || inspected[env()]) return;
      inspected[env()] = true;
      const id = ++seq;
      pendingInspect.set(id, env());
      vscode.postMessage({ type: "inspect", env: env(), expr: "_G", id });
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
      node.el.toggle.disabled = !(
        (node.type === "table" || node.type === "function") &&
        node.ref > 0
      );
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
      preview.className = `preview t-${v.type}`;
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

    // Open + fetch a table's children. `onChildren` (optional) is the sweep drain
    // continuation, invoked with the freshly attached children.
    function openTable(node, onChildren) {
      node.open = true;
      node.loading = true;
      node.el.children.style.display = "";
      updateToggleIcon(node);
      const nodeId = ++seq;
      pendingExpand.set(nodeId, { node, onChildren });
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
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text);
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
      const root = trees[env()];
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
      const root = trees[env()];
      if (!root || explorerDisabled()) return;
      const gen = ++sweepGen;
      const maxDepth = core.sweepMaxDepth(filter, ctx.getWildcardDepth());
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
      if (env() === "mission")
        showNotice("Mission sweep can be slow — each fetch waits on the sim thread.");
      else clearNotice();
      const drain = () => {
        if (gen !== sweepGen) return; // superseded
        if (spent >= core.SWEEP_BUDGET) {
          showNotice(`Sweep hit the ${core.SWEEP_BUDGET}-fetch limit — refine the pattern.`);
          applyFilter();
          return;
        }
        if (!queue.length) {
          applyFilter();
          if (env() !== "mission") clearNotice();
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
      vscode.postMessage({ type: "clearExplorer", envs: [env()] });
      trees[env()] = null;
      inspected[env()] = false;
      const c = envContainers[env()];
      if (c) c.innerHTML = "";
      clearNotice();
      ensureInspected();
    });

    // The tree round-trip replies the console router delegates to us.
    function handleMessage(m) {
      switch (m.type) {
        case "inspectResult": {
          const rEnv = pendingInspect.get(m.id) || m.env;
          pendingInspect.delete(m.id);
          const container = ensureContainer(rEnv);
          container.innerHTML = "";
          if (!m.ok) {
            inspected[rEnv] = false; // allow a retry
            const err = document.createElement("div");
            err.className = "entry error";
            err.textContent = `${m.expr || "_G"} — ${m.err || "error"}`;
            container.appendChild(err);
            break;
          }
          const root = makeNode(
            {
              key: m.expr || "_G",
              path: "_G",
              depth: 0,
              type: m.luaType,
              value: m.value,
              ref: m.ref,
            },
            rEnv,
          );
          root.el.node.classList.add("root");
          trees[rEnv] = root;
          container.appendChild(root.el.node);
          // Auto-expand the root so the top-level keys show immediately.
          if (root.type === "table" && root.ref > 0) openTable(root);
          if (rEnv === env()) applyFilter();
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
            if (p.onChildren) p.onChildren([]);
            break;
          }
          node.loaded = true;
          node.children = (m.variables || []).map((v) =>
            makeNode(
              {
                key: v.name,
                path: core.childPath(node.path, v.name),
                depth: node.depth + 1,
                type: v.type,
                value: v.value,
                ref: v.ref,
              },
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
          if (node.env === env()) applyFilter();
          if (p.onChildren) p.onChildren(node.children);
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
            node.el.preview.textContent = m.native ? `${node.signature}  (native)` : node.signature;
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
          if (m.error) showNotice(`export failed — ${m.error}`);
          break;
        }
      }
    }

    return {
      showEnvTree,
      ensureInspected,
      applyFilter,
      updateSweepEnabled,
      isDisabled: explorerDisabled,
      handleMessage,
    };
  }

  window.DcsConsoleExplorer = { svg, create };
})();
