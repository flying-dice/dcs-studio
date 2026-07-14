// @ts-nocheck
// My Mods — manage subscribed mods: enable/disable (symlinks), update, uninstall.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const state = { dataDir: "", uninstallBat: "", mods: [], busy: {}, progress: {}, running: {}, epError: {} };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  const post = (m) => vscode.postMessage(m);

  const ICO = {
    update: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>`,
    folder: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2Z"/></svg>`,
    trash: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
    gh: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.87-.01-1.71-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.4 9.4 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.35 4.8-4.58 5.05.36.32.68.94.68 1.9 0 2.10-.02 2.32-.02 2.64 0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z"/></svg>`,
    refresh: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>`,
    desktop: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>`,
    dot: `<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>`,
  };

  // One entrypoint row (Launch/Stop + running state + inline error). Only shown
  // under enabled mods that declare [[entrypoint]] blocks.
  function epRow(m, ep) {
    const key = m.repo + "::" + ep.id;
    const running = !!state.running[key];
    const err = state.epError[key];
    return `
      <div class="ep-row" data-testid="entrypoint-row" data-ep="${esc(key)}">
        <div class="ep-info">
          <span class="ep-name">${esc(ep.name || ep.id)}</span>
          <span class="ep-exe mono">${esc(ep.exe)}</span>
          ${err ? `<span class="ep-error" data-testid="entrypoint-error">${esc(err)}</span>` : ""}
        </div>
        <div class="ep-actions">
          ${running
            ? `<span class="ep-state" data-testid="entrypoint-running">${ICO.dot} Running</span><button class="btn secondary" data-stop="${esc(m.repo)}" data-id="${esc(ep.id)}" data-testid="stop-btn">Stop</button>`
            : `<button class="btn" data-launch="${esc(m.repo)}" data-id="${esc(ep.id)}" data-testid="launch-btn">Launch</button>`}
        </div>
      </div>`;
  }

  function entrypointsBlock(m) {
    const eps = m.entrypoints || [];
    if (!m.enabled || !eps.length) return "";
    return `<div class="entrypoints" data-testid="entrypoints" data-repo="${esc(m.repo)}">${eps.map((ep) => epRow(m, ep)).join("")}</div>`;
  }

  function modRow(m) {
    const busy = state.busy[m.repo];
    const prog = state.progress[m.repo];
    return `
      <div class="mod-wrap">
        <div class="mod">
          <label class="switch" title="${m.enabled ? "Enabled — symlinked into DCS" : "Disabled — unpacked but not linked"}">
            <input type="checkbox" data-toggle="${esc(m.repo)}" ${m.enabled ? "checked" : ""} ${busy ? "disabled" : ""} />
            <span class="slider"></span>
          </label>
          <div class="info">
            <div class="name">${esc(m.name)}</div>
            <div class="meta">
              <span>${esc(m.repo)}</span>
              <span>${esc(m.tag)}</span>
              <span class="pill ${m.enabled ? "on" : "off"}">${m.enabled ? m.links + " link" + (m.links === 1 ? "" : "s") : "disabled"}</span>
              ${prog ? `<span class="progress"><span class="spin">${ICO.refresh}</span> ${esc(prog)}</span>` : ""}
            </div>
          </div>
          <div class="actions">
            <button class="btn secondary" data-update="${esc(m.repo)}" ${busy ? "disabled" : ""} title="Check for and install a newer release">${ICO.update} Update</button>
            <button class="btn secondary icon-btn" data-dir="${esc(m.repo)}" title="Open the unpacked folder">${ICO.folder}</button>
            <button class="btn secondary icon-btn" data-gh="${esc(m.repo)}" title="View on GitHub">${ICO.gh}</button>
            <button class="btn secondary icon-btn danger" data-uninstall="${esc(m.repo)}" ${busy ? "disabled" : ""} title="Uninstall (remove links + unpacked files)">${ICO.trash}</button>
          </div>
        </div>
        ${entrypointsBlock(m)}
      </div>`;
  }

  function render() {
    app.innerHTML = `
      <header>
        <div style="display:flex;flex-direction:column;line-height:1.2"><span class="kicker">DCS&nbsp;Studio</span><span class="title">My Mods</span></div>
        <span class="spacer"></span>
        <button class="btn secondary" id="shortcut" title="Add a Desktop / Start Menu shortcut that opens My Mods in its own window">${ICO.desktop} Add shortcut</button>
        <button class="btn secondary" id="refresh">Refresh</button>
      </header>
      <div class="wrap">
        <div class="datadir">Data dir: ${esc(state.dataDir)}</div>
        ${state.mods.length === 0
          ? `<div class="empty"><div class="big">No mods installed yet</div>Browse Mods and install one — it'll appear here to enable, update, or remove.</div>`
          : state.mods.map(modRow).join("")}
        <div class="mod" style="margin-top:8px">
          <div class="info">
            <div class="name">Clean uninstall</div>
            <div class="meta"><span>A script that removes every mod link + unpacked data, in one go.</span><span class="mono">${esc(state.uninstallBat)}</span></div>
          </div>
          <div class="actions">
            <button class="btn secondary" id="revealBat">Reveal script</button>
            <button class="btn secondary danger" id="cleanBtn">Run clean uninstall</button>
          </div>
        </div>
      </div>`;
    document.getElementById("refresh").addEventListener("click", () => post({ type: "refresh" }));
    document.getElementById("shortcut").addEventListener("click", () => post({ type: "createShortcut" }));
    document.getElementById("revealBat").addEventListener("click", () => post({ type: "revealBat" }));
    document.getElementById("cleanBtn").addEventListener("click", () => post({ type: "cleanUninstall" }));
    document.querySelectorAll("[data-toggle]").forEach((el) =>
      el.addEventListener("change", () => {
        const repo = el.dataset.toggle;
        state.busy[repo] = true;
        post({ type: el.checked ? "enable" : "disable", repo });
      }),
    );
    document.querySelectorAll("[data-update]").forEach((el) => el.addEventListener("click", () => { state.busy[el.dataset.update] = true; state.progress[el.dataset.update] = "Updating…"; render(); post({ type: "update", repo: el.dataset.update }); }));
    document.querySelectorAll("[data-uninstall]").forEach((el) => el.addEventListener("click", () => { state.busy[el.dataset.uninstall] = true; post({ type: "uninstall", repo: el.dataset.uninstall }); }));
    document.querySelectorAll("[data-dir]").forEach((el) => el.addEventListener("click", () => post({ type: "openDir", repo: el.dataset.dir })));
    document.querySelectorAll("[data-gh]").forEach((el) => el.addEventListener("click", () => post({ type: "openExternal", url: "https://github.com/" + el.dataset.gh })));
    document.querySelectorAll("[data-launch]").forEach((el) =>
      el.addEventListener("click", () => post({ type: "launch", repo: el.dataset.launch, id: el.dataset.id })),
    );
    document.querySelectorAll("[data-stop]").forEach((el) =>
      el.addEventListener("click", () => post({ type: "stop", repo: el.dataset.stop, id: el.dataset.id })),
    );
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === "init") { state.dataDir = m.dataDir; state.uninstallBat = m.uninstallBat || ""; state.mods = m.mods; state.busy = {}; state.progress = {}; state.running = m.running || {}; state.epError = {}; render(); }
    else if (m.type === "busy") { state.busy[m.repo] = m.busy; render(); }
    else if (m.type === "progress") { state.progress[m.repo] = m.label; render(); }
    else if (m.type === "entrypoint") {
      const key = m.repo + "::" + m.id;
      state.running[key] = !!m.running;
      if (m.error) state.epError[key] = m.error; else delete state.epError[key];
      render();
    }
  });

  post({ type: "refresh" });
})();
