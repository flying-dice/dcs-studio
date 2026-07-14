// @ts-nocheck
// DCS Log viewer: live tail of Saved Games/DCS/Logs/dcs.log. The host
// (src/log/logPanel.ts) does all parsing/buffering/mod-matching via the
// tested core (src/core/domain/dcsLog.ts) — this webview only mirrors the
// entries it's given locally and does trivial level/text/mine filtering over
// that local array. No domain logic here.
//
// Host -> webview: init {entries, mod, file, state} (reply to "ready"),
//   append {entries, cont, dropped}, reset {}, fileState {state, file},
//   mod {mod}.
// Webview -> host: ready, clear, openSettings.
(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");

  const LEVELS = ["INFO", "WARNING", "ERROR", "DEBUG", "ALERT"];
  const CAP = 5000;

  const state = {
    entries: new Map(), // seq -> { seq, level, subsystem, message, mine, cont, wrapEl, contEl, contRendered }
    order: [], // seq, oldest first — the local mirror, capped at CAP
    levels: new Set(LEVELS), // all on by default
    mineOnly: false,
    filterRaw: "",
    filterRegex: null,
    filterInvalid: false,
    mod: null,
    fileState: "missing",
    filePath: "",
    dropped: 0,
    autoscroll: true,
    pendingNew: 0,
  };

  const { esc } = dcsUi;

  app.innerHTML = `
    <div class="toolbar">
      <div class="levels" id="levels">
        ${LEVELS.map((l) => `<button class="chip level-${l.toLowerCase()} active" data-testid="level-chip" data-level="${l}">${l}</button>`).join("")}
      </div>
      <button class="chip mine hidden" id="mineToggle" data-testid="mine-toggle">My mod</button>
      <input id="textFilter" class="filter-input" data-testid="text-filter" placeholder="Filter…  /regex/ for regex" spellcheck="false" autocomplete="off" />
      <span class="count" id="count" data-testid="entry-count">0</span>
      <span class="dropped hidden" id="dropped" data-testid="dropped-badge"></span>
      <button class="btn subtle" id="clearBtn" data-testid="clear-btn">Clear</button>
    </div>
    <div class="body">
      <div class="missing-pane hidden" id="missingPane" data-testid="missing-pane">
        <p>dcs.log not found at <code id="missingPath"></code>.</p>
        <p class="hint">Check your DCS <b>Saved Games</b> path in settings.</p>
        <button class="btn" id="openSettingsBtn" data-testid="open-settings-btn">Open Settings</button>
      </div>
      <div class="grid-wrap" id="gridWrap">
        <div class="grid" id="grid" data-testid="log-grid"></div>
        <button class="autoscroll-pill hidden" id="autoscrollPill" data-testid="autoscroll-pill">↓ 0 new</button>
      </div>
    </div>
  `;

  const levelsEl = document.getElementById("levels");
  const mineToggleEl = document.getElementById("mineToggle");
  const textFilterEl = document.getElementById("textFilter");
  const countEl = document.getElementById("count");
  const droppedEl = document.getElementById("dropped");
  const clearBtn = document.getElementById("clearBtn");
  const missingPaneEl = document.getElementById("missingPane");
  const missingPathEl = document.getElementById("missingPath");
  const openSettingsBtn = document.getElementById("openSettingsBtn");
  const gridWrapEl = document.getElementById("gridWrap");
  const gridEl = document.getElementById("grid");
  const pillEl = document.getElementById("autoscrollPill");

  // --- Toolbar wiring ---
  levelsEl.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const level = chip.dataset.level;
      if (state.levels.has(level)) {
        state.levels.delete(level);
        chip.classList.remove("active");
      } else {
        state.levels.add(level);
        chip.classList.add("active");
      }
      applyFilters();
    });
  });

  mineToggleEl.addEventListener("click", () => {
    if (!state.mod) return;
    state.mineOnly = !state.mineOnly;
    mineToggleEl.classList.toggle("active", state.mineOnly);
    applyFilters();
  });

  textFilterEl.addEventListener("input", () => {
    setTextFilter(textFilterEl.value);
  });

  clearBtn.addEventListener("click", () => {
    clearLocal();
    vscode.postMessage({ type: "clear" });
  });

  openSettingsBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "openSettings" });
  });

  gridEl.addEventListener("scroll", () => {
    const nearBottom = gridEl.scrollHeight - gridEl.scrollTop - gridEl.clientHeight < 24;
    state.autoscroll = nearBottom;
    if (nearBottom) {
      state.pendingNew = 0;
      updatePill();
    }
  });

  pillEl.addEventListener("click", () => {
    state.autoscroll = true;
    state.pendingNew = 0;
    updatePill();
    gridEl.scrollTop = gridEl.scrollHeight;
  });

  // --- Filtering ---
  function setTextFilter(raw) {
    const m = /^\/(.*)\/$/.exec(raw);
    if (m) {
      try {
        state.filterRegex = new RegExp(m[1], "i");
        state.filterInvalid = false;
      } catch {
        state.filterRegex = null;
        state.filterInvalid = true;
      }
    } else {
      state.filterRegex = null;
      state.filterInvalid = false;
    }
    state.filterRaw = raw;
    textFilterEl.classList.toggle("invalid", state.filterInvalid);
    applyFilters();
  }

  function passesFilters(rec) {
    if (rec.level && !state.levels.has(rec.level)) return false;
    if (state.mineOnly && !rec.mine) return false;
    if (!state.filterRaw || state.filterInvalid) return true;
    const hay = rec.message + (rec.cont.length ? ` ${rec.cont.join(" ")}` : "");
    if (state.filterRegex) return state.filterRegex.test(hay);
    return hay.toLowerCase().includes(state.filterRaw.toLowerCase());
  }

  function applyFilters() {
    for (const seq of state.order) {
      const rec = state.entries.get(seq);
      rec.wrapEl.classList.toggle("hidden", !passesFilters(rec));
    }
  }

  // --- Row rendering ---
  function fmtTime(t) {
    if (!t) return "";
    const idx = t.indexOf(" ");
    return idx >= 0 ? t.slice(idx + 1) : t;
  }

  function buildRow(e) {
    const wrapEl = document.createElement("div");
    wrapEl.className = "entry-wrap";
    wrapEl.dataset.seq = String(e.seq);
    wrapEl.dataset.level = e.level || "";
    wrapEl.dataset.mine = e.mine ? "1" : "0";
    wrapEl.setAttribute("data-testid", "log-row");

    const row = document.createElement("div");
    row.className = `row level-${e.level ? e.level.toLowerCase() : "other"}${e.mine ? " mine" : ""}`;
    row.innerHTML = `
      <span class="time">${esc(fmtTime(e.time))}</span>
      <span class="level">${esc(e.level || "")}</span>
      <span class="subsystem">${esc(e.subsystem || "")}</span>
      <span class="message">${esc(e.message)}</span>
    `;
    wrapEl.appendChild(row);

    const contEl = document.createElement("div");
    contEl.className = "cont-lines";
    wrapEl.appendChild(contEl);

    const rec = {
      seq: e.seq,
      level: e.level,
      subsystem: e.subsystem,
      message: e.message,
      mine: e.mine,
      cont: e.cont || [],
      wrapEl,
      contEl,
      contRendered: 0,
    };
    renderContLines(rec);
    return rec;
  }

  function renderContLines(rec) {
    const frag = document.createDocumentFragment();
    for (let i = rec.contRendered; i < rec.cont.length; i++) {
      const cRow = document.createElement("div");
      cRow.className = "cont-line";
      cRow.textContent = rec.cont[i];
      frag.appendChild(cRow);
    }
    rec.contEl.appendChild(frag);
    rec.contRendered = rec.cont.length;
  }

  function addRecord(rec) {
    state.entries.set(rec.seq, rec);
    state.order.push(rec.seq);
    evictOverCap();
  }

  function evictOverCap() {
    while (state.order.length > CAP) {
      const seq = state.order.shift();
      const rec = state.entries.get(seq);
      if (rec) rec.wrapEl.remove();
      state.entries.delete(seq);
    }
  }

  // --- Bulk (init/reset) vs incremental (append) rendering ---
  function renderAll(entries) {
    gridEl.innerHTML = "";
    state.entries.clear();
    state.order.length = 0;
    const frag = document.createDocumentFragment();
    for (const e of entries) {
      const rec = buildRow(e);
      state.entries.set(rec.seq, rec);
      state.order.push(rec.seq);
      frag.appendChild(rec.wrapEl);
    }
    gridEl.appendChild(frag);
    evictOverCap();
    applyFilters();
    updateCount();
    state.autoscroll = true;
    state.pendingNew = 0;
    updatePill();
    gridEl.scrollTop = gridEl.scrollHeight;
  }

  function appendEntries(newEntries, contUpdates, droppedDelta) {
    requestAnimationFrame(() => {
      const frag = document.createDocumentFragment();
      for (const e of newEntries) {
        const rec = buildRow(e);
        addRecord(rec);
        frag.appendChild(rec.wrapEl);
      }
      gridEl.appendChild(frag);
      for (const c of contUpdates || []) {
        const rec = state.entries.get(c.seq);
        if (rec) {
          rec.cont = c.cont;
          renderContLines(rec);
        }
      }
      if (droppedDelta) {
        state.dropped += droppedDelta;
        updateDroppedBadge();
      }
      applyFilters();
      updateCount();
      if (state.autoscroll) {
        gridEl.scrollTop = gridEl.scrollHeight;
      } else if (newEntries.length) {
        state.pendingNew += newEntries.length;
        updatePill();
      }
    });
  }

  function clearLocal() {
    gridEl.innerHTML = "";
    state.entries.clear();
    state.order.length = 0;
    state.dropped = 0;
    state.pendingNew = 0;
    updateDroppedBadge();
    updateCount();
    updatePill();
  }

  function showRestartDivider() {
    const div = document.createElement("div");
    div.className = "divider";
    div.setAttribute("data-testid", "restart-divider");
    div.textContent = "— log restarted —";
    gridEl.appendChild(div);
  }

  // --- Status widgets ---
  function updateCount() {
    countEl.textContent = String(state.order.length);
  }

  function updateDroppedBadge() {
    droppedEl.textContent = state.dropped ? `${state.dropped} dropped` : "";
    droppedEl.classList.toggle("hidden", state.dropped === 0);
  }

  function updatePill() {
    pillEl.textContent = `↓ ${state.pendingNew} new`;
    pillEl.classList.toggle("hidden", state.autoscroll || state.pendingNew === 0);
  }

  function renderModToggle() {
    if (state.mod) {
      mineToggleEl.classList.remove("hidden");
      mineToggleEl.textContent = `My mod: ${state.mod.name}`;
    } else {
      mineToggleEl.classList.add("hidden");
      state.mineOnly = false;
      mineToggleEl.classList.remove("active");
    }
  }

  function renderFileState() {
    const missing = state.fileState === "missing";
    missingPaneEl.classList.toggle("hidden", !missing);
    gridWrapEl.classList.toggle("hidden", missing);
    missingPathEl.textContent = state.filePath || "";
  }

  // --- Host messages ---
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m) return;
    switch (m.type) {
      case "init":
        state.mod = m.mod;
        state.filePath = m.file;
        state.fileState = m.state;
        renderModToggle();
        renderFileState();
        renderAll(m.entries || []);
        break;
      case "append":
        appendEntries(m.entries || [], m.cont || [], m.dropped || 0);
        break;
      case "reset":
        clearLocal();
        showRestartDivider();
        break;
      case "fileState":
        state.fileState = m.state;
        state.filePath = m.file;
        renderFileState();
        break;
      case "mod":
        state.mod = m.mod;
        renderModToggle();
        applyFilters();
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
