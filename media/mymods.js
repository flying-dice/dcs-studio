// @ts-nocheck
// My Mods — manage subscribed mods: enable/disable (symlinks), update, uninstall.
(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const state = {
    dataDir: "",
    uninstallBat: "",
    mods: [],
    busy: {},
    progress: {},
    running: {},
    epError: {},
  };

  const { esc, iconPaths } = dcsUi;
  const post = (m) => vscode.postMessage(m);

  const ICO = {
    update: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconPaths.refresh}</svg>`,
    folder: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2Z"/></svg>`,
    trash: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
    gh: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">${iconPaths.github}</svg>`,
    refresh: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconPaths.refresh}</svg>`,
    desktop: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>`,
    dot: `<svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>`,
    warn: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>`,
    box: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>`,
    link: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5"/></svg>`,
    term: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>`,
    script: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>`,
  };

  // ── Install-manifest breakdown (issue #12) — the same transparency the product
  // page shows, for already-installed mods, driven from the ledger snapshot. The
  // badge strip + script-execution notice are the shared dcsUi renderers; the
  // per-surface class names / test-ids / body copy are passed in. ──
  function riskBadges(view) {
    return dcsUi.riskBadges(view, {
      wrapClass: "mm-risks",
      wrapTestid: "mod-risks",
      badgeClass: "mm-risk",
      badgeTestid: "mod-risk-badge",
      warnIcon: ICO.warn,
      okIcon: "",
    });
  }

  function sanitizeNotice(count) {
    const n = count === 1 ? "1 script that runs" : `${count} scripts that run`;
    return dcsUi.sanitizeNotice({
      wrapClass: "mm-alert",
      wrapTestid: "mod-sanitize-notice",
      headClass: "mm-alert-head",
      icon: ICO.warn,
      body: `<div>This mod includes ${esc(n)} <strong>before</strong> DCS World's scripting sandbox is applied, with full os/io/lfs/require access. Ensure you trust the source.</div>`,
      linkClass: "mm-link",
      learnTestid: "mod-sanitize-learn-more",
    });
  }

  function manifestBlock(m) {
    const v = m.manifest;
    if (!v?.known) return "";
    const c = v.counts;
    if (!c.bundles && !c.symlinks && !c.entrypoints && !c.missionScripts) return "";
    const rows = [];
    rows.push(riskBadges(v));
    if (c.beforeSanitize) rows.push(sanitizeNotice(c.beforeSanitize));
    if (v.symlinks.length)
      rows.push(
        `<div class="mm-sec" data-testid="mod-symlinks"><div class="mm-sec-h">${ICO.link} Symlinks <span class="mm-count">${c.symlinks}</span></div>` +
          v.symlinks
            .map(
              (s) =>
                `<div class="mm-item" data-testid="mod-symlink"><span class="mono">${esc(s.source)}</span> &rarr; <span class="mono">${esc(s.resolved || s.dest)}</span></div>`,
            )
            .join("") +
          `</div>`,
      );
    if (v.entrypoints.length)
      rows.push(
        `<div class="mm-sec warn" data-testid="mod-executables"><div class="mm-sec-h warn">${ICO.warn} Executables <span class="mm-count warn">${c.entrypoints}</span></div>` +
          v.entrypoints
            .map(
              (e) =>
                `<div class="mm-item" data-testid="mod-executable">${ICO.term} <strong>${esc(e.name)}</strong> <span class="mono">${esc(e.exe)}</span></div>`,
            )
            .join("") +
          `</div>`,
      );
    if (v.missionScripts.length)
      rows.push(
        `<div class="mm-sec${c.beforeSanitize ? " warn" : ""}" data-testid="mod-mission-scripts"><div class="mm-sec-h${c.beforeSanitize ? " warn" : ""}">${ICO.script} Mission scripts <span class="mm-count">${c.missionScripts}</span>${
          c.beforeSanitize
            ? ` <span class="mm-count warn" data-testid="mod-before-sanitize-badge">${c.beforeSanitize} before-sanitize</span>`
            : ""
        }</div>` +
          v.missionScripts
            .map(
              (s) =>
                `<div class="mm-item${s.beforeSanitize ? " warn" : ""}" data-testid="mod-mission-script" data-run="${esc(s.run_on)}">${ICO.script} <strong>${esc(s.name)}</strong>${
                  s.beforeSanitize ? ` <span class="mm-badge warn">before-sanitize</span>` : ""
                } <span class="mono">${esc(s.path)}</span></div>`,
            )
            .join("") +
          `</div>`,
      );
    return `<div class="mm-manifest" data-testid="mod-manifest" data-repo="${esc(m.repo)}">${rows.join("")}</div>`;
  }

  // One entrypoint row (Launch/Stop + running state + inline error). Only shown
  // under enabled mods that declare [[entrypoint]] blocks.
  function epRow(m, ep) {
    const key = `${m.repo}::${ep.id}`;
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
          ${
            running
              ? `<span class="ep-state" data-testid="entrypoint-running">${ICO.dot} Running</span><button class="btn secondary" data-stop="${esc(m.repo)}" data-id="${esc(ep.id)}" data-testid="stop-btn">Stop</button>`
              : `<button class="btn" data-launch="${esc(m.repo)}" data-id="${esc(ep.id)}" data-testid="launch-btn">Launch</button>`
          }
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
              <span class="pill ${m.enabled ? "on" : "off"}">${m.enabled ? `${m.links} link${m.links === 1 ? "" : "s"}` : "disabled"}</span>
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
        ${manifestBlock(m)}
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
        ${
          state.mods.length === 0
            ? `<div class="empty"><div class="big">No mods installed yet</div>Browse Mods and install one — it'll appear here to enable, update, or remove.</div>`
            : state.mods.map(modRow).join("")
        }
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
    document
      .getElementById("shortcut")
      .addEventListener("click", () => post({ type: "createShortcut" }));
    document
      .getElementById("revealBat")
      .addEventListener("click", () => post({ type: "revealBat" }));
    document
      .getElementById("cleanBtn")
      .addEventListener("click", () => post({ type: "cleanUninstall" }));
    document.querySelectorAll("[data-toggle]").forEach((el) => {
      el.addEventListener("change", () => {
        const repo = el.dataset.toggle;
        state.busy[repo] = true;
        post({ type: el.checked ? "enable" : "disable", repo });
      });
    });
    document.querySelectorAll("[data-update]").forEach((el) => {
      el.addEventListener("click", () => {
        state.busy[el.dataset.update] = true;
        state.progress[el.dataset.update] = "Updating…";
        render();
        post({ type: "update", repo: el.dataset.update });
      });
    });
    document.querySelectorAll("[data-uninstall]").forEach((el) => {
      el.addEventListener("click", () => {
        state.busy[el.dataset.uninstall] = true;
        post({ type: "uninstall", repo: el.dataset.uninstall });
      });
    });
    document.querySelectorAll("[data-dir]").forEach((el) => {
      el.addEventListener("click", () => post({ type: "openDir", repo: el.dataset.dir }));
    });
    document.querySelectorAll("[data-gh]").forEach((el) => {
      el.addEventListener("click", () =>
        post({ type: "openExternal", url: `https://github.com/${el.dataset.gh}` }),
      );
    });
    document.querySelectorAll("[data-launch]").forEach((el) => {
      el.addEventListener("click", () =>
        post({ type: "launch", repo: el.dataset.launch, id: el.dataset.id }),
      );
    });
    document.querySelectorAll("[data-stop]").forEach((el) => {
      el.addEventListener("click", () =>
        post({ type: "stop", repo: el.dataset.stop, id: el.dataset.id }),
      );
    });
    document.querySelectorAll("[data-docs]").forEach((el) => {
      el.addEventListener("click", () => post({ type: "openDocs", page: el.dataset.docs }));
    });
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === "init") {
      state.dataDir = m.dataDir;
      state.uninstallBat = m.uninstallBat || "";
      state.mods = m.mods;
      state.busy = {};
      state.progress = {};
      state.running = m.running || {};
      state.epError = {};
      render();
    } else if (m.type === "busy") {
      state.busy[m.repo] = m.busy;
      render();
    } else if (m.type === "progress") {
      state.progress[m.repo] = m.label;
      render();
    } else if (m.type === "entrypoint") {
      const key = `${m.repo}::${m.id}`;
      state.running[key] = !!m.running;
      if (m.error) state.epError[key] = m.error;
      else delete state.epError[key];
      render();
    }
  });

  post({ type: "refresh" });
})();
