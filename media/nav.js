// @ts-nocheck
// Website-style sidebar navigation. Each row runs a command in the host; a
// footer reflects the live bridge status.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");

  const I = {
    store: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1.5-5h15L21 9M4 9h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9Z"/><path d="M9 9v2a3 3 0 0 1-6 0V9m18 0v2a3 3 0 0 1-6 0V9M9 9v2a3 3 0 0 0 6 0V9"/></svg>`,
    edit: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"/></svg>`,
    layers: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/></svg>`,
    terminal: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></svg>`,
    shield: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3Z"/></svg>`,
    gear: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>`,
    rocket: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>`,
    book: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></svg>`,
    sparkle: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z"/></svg>`,
    chev: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`,
  };

  // In the requested order. Settings is separated to the bottom, website-style.
  // "hidden" rows stay display:none until a host message reveals them.
  const ITEMS = [
    { id: "browse", label: "Browse Mods", desc: "Discover & install community mods", command: "dcs.marketplace.open", icon: "store" },
    { id: "mymods", label: "My Mods", desc: "Enable, update & remove installed mods", command: "dcs.mymods.open", icon: "layers" },
    { id: "create", label: "Create a Mod", desc: "Start a new project from a template", command: "dcs.manifest.author", icon: "edit" },
    { id: "publish", label: "Publish Mod", desc: "Preflight, share to GitHub & cut a release", command: "dcs.publish.open", icon: "rocket", hidden: true },
    { id: "console", label: "DCS Console", desc: "Run Lua in the live sim", command: "dcs.bridge.console", icon: "terminal" },
    { id: "mission", label: "MissionScripting", desc: "Sanitization toggle", command: "dcs.mission.open", icon: "shield" },
    { id: "skills", label: "Agent Skills", desc: "AI skill files for your repo", command: "dcs.skills.open", icon: "sparkle" },
    { id: "docs", label: "Documentation", desc: "Guides for every feature", command: "dcs.docs.open", icon: "book", footer: true },
    { id: "settings", label: "Settings", desc: "DCS paths & options", command: "dcs.setup.open", icon: "gear", footer: true },
  ];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function itemHtml(it) {
    return `
      <button class="nav-item${it.hidden ? " hidden" : ""}" data-testid="nav-item" data-id="${it.id}" data-command="${it.command}" title="${esc(it.label)}">
        ${I[it.icon]}
        <span class="txt">
          <span class="label">${esc(it.label)}</span>
          <span class="desc">${esc(it.desc)}</span>
        </span>
        <span class="badge hidden" data-testid="nav-badge"></span>
        <span class="chev">${I.chev}</span>
      </button>`;
  }

  const main = ITEMS.filter((i) => !i.footer);
  const footer = ITEMS.filter((i) => i.footer);

  app.innerHTML = `
    <div class="brand">
      <img src="${window.__LOGO__}" alt="" />
      <span class="names">
        <span class="kicker">DCS&nbsp;Studio</span>
        <span class="word">DCS Studio</span>
      </span>
    </div>
    <div class="rule"></div>
    <nav>
      ${main.map(itemHtml).join("")}
      <div class="spacer-divider"></div>
      ${footer.map(itemHtml).join("")}
    </nav>
    <div class="footer">
      <span class="dot off" id="dot" data-testid="status-dot"></span>
      <span class="flabel" id="flabel" data-testid="status-label">Bridge offline</span>
      <span class="ftime" id="ftime" data-testid="status-time"></span>
    </div>
  `;

  let active = null;
  app.querySelectorAll(".nav-item").forEach((el) => {
    el.addEventListener("click", () => {
      if (active) active.classList.remove("active");
      el.classList.add("active");
      active = el;
      vscode.postMessage({ type: "run", command: el.dataset.command });
    });
  });

  const dot = document.getElementById("dot");
  const flabel = document.getElementById("flabel");
  const ftime = document.getElementById("ftime");
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m) return;
    // With a manifest in the workspace, "Create a Mod" is really editing,
    // and Publish Mod becomes available.
    if (m.type === "manifest") {
      const row = app.querySelector('.nav-item[data-id="create"]');
      if (row) {
        row.querySelector(".label").textContent = m.hasManifest ? "Edit Project" : "Create a Mod";
        row.querySelector(".desc").textContent = m.hasManifest
          ? "Open the dcs-studio.toml editor"
          : "Start a new project from a template";
        row.title = m.hasManifest ? "Edit Project" : "Create a Mod";
      }
      const pub = app.querySelector('.nav-item[data-id="publish"]');
      if (pub) pub.classList.toggle("hidden", !m.hasManifest);
      return;
    }
    // Installed skill files with a newer bundled version: badge the row.
    if (m.type === "skills") {
      const row = app.querySelector('.nav-item[data-id="skills"]');
      if (row) {
        const badge = row.querySelector(".badge");
        badge.textContent = m.updates > 0 ? String(m.updates) : "";
        badge.classList.toggle("hidden", !(m.updates > 0));
        row.querySelector(".desc").textContent =
          m.updates > 0 ? "Skill update available" : "AI skill files for your repo";
      }
      return;
    }
    if (m.type !== "status") return;
    const s = m.status;
    if (!s.connected) {
      dot.className = "dot off";
      flabel.textContent = "Bridge offline";
      ftime.textContent = "";
    } else if (s.dcsTime && s.dcsTime > 0) {
      dot.className = "dot mission";
      flabel.textContent = "Mission running";
      ftime.textContent = "t " + s.dcsTime.toFixed(0) + "s";
    } else {
      dot.className = "dot menu";
      flabel.textContent = "At menu";
      ftime.textContent = "";
    }
  });
})();
