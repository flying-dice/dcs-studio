// @ts-nocheck
// Agent Skills panel: cards for each bundled skill file with its installed
// state in the workspace repo. All state arrives from the host as a
// { type: "skills", skills, installDir, hasWorkspace } message; buttons post
// { type: install|open|viewBundled|remove, id } back.
(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");

  const STATUS = {
    "no-workspace": { label: "No folder open", cls: "muted" },
    "not-installed": { label: "Not installed", cls: "muted" },
    "up-to-date": { label: "Installed · up to date", cls: "ok" },
    outdated: { label: "Update available", cls: "warn" },
    modified: { label: "Installed · locally modified", cls: "info" },
  };

  const { esc } = dcsUi;

  function versionLine(s) {
    if (!s.installedVersion) return `v${esc(s.bundledVersion)}`;
    if (s.status === "outdated")
      return `installed v${esc(s.installedVersion)} → bundled v${esc(s.bundledVersion)}`;
    return `installed v${esc(s.installedVersion)}`;
  }

  // data-act -> data-testid, per the previews/ data-testid convention doc.
  const ACT_TESTID = {
    install: "install-btn",
    open: "open-installed-btn",
    remove: "remove-btn",
    viewBundled: "view-bundled-btn",
  };

  function buttons(s, hasWorkspace) {
    const b = [];
    if (s.status === "not-installed" && hasWorkspace)
      b.push(
        `<button class="btn primary" data-act="install" data-testid="${ACT_TESTID.install}" data-id="${s.id}">Install into repo</button>`,
      );
    if (s.status === "outdated")
      b.push(
        `<button class="btn primary" data-act="install" data-testid="${ACT_TESTID.install}" data-id="${s.id}">Update to v${esc(s.bundledVersion)}</button>`,
      );
    if (s.status === "modified")
      b.push(
        `<button class="btn" data-act="install" data-testid="${ACT_TESTID.install}" data-id="${s.id}">Reset to bundled</button>`,
      );
    if (s.installedVersion) {
      b.push(
        `<button class="btn" data-act="open" data-testid="${ACT_TESTID.open}" data-id="${s.id}">Open installed</button>`,
      );
      b.push(
        `<button class="btn subtle" data-act="remove" data-testid="${ACT_TESTID.remove}" data-id="${s.id}">Remove</button>`,
      );
    }
    b.push(
      `<button class="btn subtle" data-act="viewBundled" data-testid="${ACT_TESTID.viewBundled}" data-id="${s.id}">View bundled</button>`,
    );
    return b.join("");
  }

  function card(s, hasWorkspace) {
    const st = STATUS[s.status] || STATUS["not-installed"];
    return `
      <div class="card" data-testid="skill-card" data-id="${s.id}">
        <div class="card-head">
          <span class="pill ${st.cls}" data-testid="status-pill">${st.label}</span>
          <span class="ver" data-testid="version-line">${versionLine(s)}</span>
        </div>
        <h2>${esc(s.name)}</h2>
        <p class="desc">${esc(s.description)}</p>
        <div class="actions">${buttons(s, hasWorkspace)}</div>
      </div>`;
  }

  function render(state) {
    const { skills, installDir, hasWorkspace } = state;
    app.innerHTML = `
      <div class="page">
        <div class="kicker">DCS Studio</div>
        <h1>Agent Skills</h1>
        <p class="lede">
          Skill files teach AI coding agents (Claude Code and compatible tools) how to
          write DCS mods and drive DCS Studio. Installing copies the file into
          <code>${esc(installDir)}</code> in your repo — commit it so every
          contributor's agent picks it up. When the extension ships a newer
          version you'll see an update here.
        </p>
        ${hasWorkspace ? "" : `<div class="note warn" data-testid="no-workspace-note">Open a folder to install skills into a repo.</div>`}
        ${skills.length ? skills.map((s) => card(s, hasWorkspace)).join("") : `<div class="note" data-testid="empty-note">No bundled skills found.</div>`}
      </div>`;

    app.querySelectorAll(".btn").forEach((el) => {
      el.addEventListener("click", () => {
        vscode.postMessage({ type: el.dataset.act, id: el.dataset.id });
      });
    });
  }

  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "skills") render(e.data);
  });
  vscode.postMessage({ type: "refresh" });
})();
