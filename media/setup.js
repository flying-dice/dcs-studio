// @ts-nocheck
// DCS install selector. Shows detected userdata (Saved Games) + installation
// candidates, lets you pick one or browse, validates, and saves to settings.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const state = {
    savedGames: "",
    gameInstall: "",
    dataDir: "",
    dataDirDefault: "",
    sevenZip: "",
    sevenZipDetected: "",
    savedCandidates: [],
    installCandidates: [],
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]),
    );
  }

  function candList(items, current, which) {
    if (!items.length) {
      return `<div class="none">Nothing detected automatically — use Browse to point at the folder.</div>`;
    }
    return items
      .map(
        (c) => `
      <button class="cand ${c.path.toLowerCase() === (current || "").toLowerCase() ? "selected" : ""}" data-pick="${which}" data-path="${esc(c.path)}">
        <span class="cname">${esc(c.name)}</span>
        <span class="cpath" title="${esc(c.path)}">${esc(c.path)}</span>
        <span class="pill ${c.valid ? "ok" : "warn"}">${esc(c.detail)}</span>
      </button>`,
      )
      .join("");
  }

  function validity(which, p) {
    if (!p) return "";
    // We only know detected candidates' validity; for a typed/current path show a
    // neutral hint (the host validates browsed picks).
    const list = which === "install" ? state.installCandidates : state.savedCandidates;
    const hit = list.find((c) => c.path.toLowerCase() === p.toLowerCase());
    if (hit) {
      return `<div class="status-line ${hit.valid ? "ok" : "warn"}">${hit.valid ? "✔ " + hit.detail : "⚠ " + hit.detail}</div>`;
    }
    return "";
  }

  function render() {
    app.innerHTML = `
      <header>
        <div style="display:flex;flex-direction:column;line-height:1.2">
          <span class="kicker">DCS&nbsp;Studio</span>
          <span class="title">DCS Setup</span>
        </div>
        <span class="spacer"></span>
        <button class="btn secondary" id="redetect">Re-detect</button>
      </header>
      <div class="wrap">
        <p class="intro">Point DCS Studio at your DCS folders. <b>Userdata</b> (Saved Games) is where the bridge hook + mods install; <b>Installation</b> is where <span class="mono">DCS.exe</span> lives (used to launch DCS). Both are saved to your user settings.</p>

        <section class="card">
          <h2>DCS userdata (Saved Games)</h2>
          <p class="sub">e.g. <span class="mono">%USERPROFILE%\\Saved Games\\DCS</span> — a valid one has a <span class="mono">Config</span> folder.</p>
          <div class="pathrow">
            <input id="savedInput" value="${esc(state.savedGames)}" placeholder="Path to your DCS Saved Games folder" spellcheck="false" />
            <button class="btn secondary" data-browse="saved">Browse…</button>
          </div>
          ${validity("saved", state.savedGames)}
          <div class="detected-label">Detected</div>
          ${candList(state.savedCandidates, state.savedGames, "saved")}
        </section>

        <section class="card">
          <h2>DCS installation</h2>
          <p class="sub">The folder containing <span class="mono">bin\\DCS.exe</span> — e.g. <span class="mono">C:\\Program Files\\Eagle Dynamics\\DCS World</span>.</p>
          <div class="pathrow">
            <input id="installInput" value="${esc(state.gameInstall)}" placeholder="Path to your DCS install folder" spellcheck="false" />
            <button class="btn secondary" data-browse="install">Browse…</button>
          </div>
          ${validity("install", state.gameInstall)}
          <div class="detected-label">Detected</div>
          ${candList(state.installCandidates, state.gameInstall, "install")}
        </section>

        <section class="card">
          <h2>DCS Studio data dir</h2>
          <p class="sub">Where subscribed mods are downloaded and unpacked. Symlinks are maintained from here into the DCS folders. Keep it off the DCS install/Saved Games.</p>
          <div class="pathrow">
            <input id="dataInput" value="${esc(state.dataDir)}" placeholder="${esc(state.dataDirDefault)}" spellcheck="false" />
            <button class="btn secondary" data-browse="data">Browse…</button>
          </div>
          <div class="status-line">Default: <span class="mono">${esc(state.dataDirDefault)}</span></div>
        </section>

        <section class="card">
          <h2>7-Zip</h2>
          <p class="sub">Used to package and unpack mod payloads. Leave empty to auto-detect on PATH or under <span class="mono">Program Files\\7-Zip</span>.</p>
          <div class="pathrow">
            <input id="sevenInput" value="${esc(state.sevenZip)}" placeholder="Path to 7z.exe (auto-detect if empty)" spellcheck="false" />
            <button class="btn secondary" data-browse="sevenzip">Browse…</button>
          </div>
          <div class="status-line ${state.sevenZipDetected ? "ok" : "warn"}">${state.sevenZipDetected ? "✔ Detected: " + esc(state.sevenZipDetected) : "⚠ 7z not found — set it here or install 7-Zip"}</div>
        </section>

        <div class="actions">
          <button class="btn" id="save">Save DCS paths</button>
          <span class="saved-note" id="savedNote" style="display:none">Saved ✓</span>
        </div>
      </div>
    `;
    bind();
  }

  function bind() {
    document.getElementById("redetect").addEventListener("click", () =>
      vscode.postMessage({ type: "redetect" }),
    );
    document.getElementById("savedInput").addEventListener("input", (e) => (state.savedGames = e.target.value));
    document.getElementById("installInput").addEventListener("input", (e) => (state.gameInstall = e.target.value));
    document.getElementById("dataInput").addEventListener("input", (e) => (state.dataDir = e.target.value));
    document.getElementById("sevenInput").addEventListener("input", (e) => (state.sevenZip = e.target.value));
    document.querySelectorAll("[data-browse]").forEach((el) =>
      el.addEventListener("click", () => vscode.postMessage({ type: "browse", which: el.dataset.browse })),
    );
    document.querySelectorAll("[data-pick]").forEach((el) =>
      el.addEventListener("click", () => {
        const which = el.dataset.pick;
        if (which === "saved") state.savedGames = el.dataset.path;
        else state.gameInstall = el.dataset.path;
        render();
      }),
    );
    document.getElementById("save").addEventListener("click", () =>
      vscode.postMessage({
        type: "save",
        savedGames: state.savedGames.trim(),
        gameInstall: state.gameInstall.trim(),
        dataDir: state.dataDir.trim(),
        sevenZip: state.sevenZip.trim(),
      }),
    );
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === "init") {
      state.savedGames = m.savedGames || "";
      state.gameInstall = m.gameInstall || "";
      state.dataDir = m.dataDir || "";
      state.dataDirDefault = m.dataDirDefault || "";
      state.sevenZip = m.sevenZip || "";
      state.sevenZipDetected = m.sevenZipDetected || "";
      state.savedCandidates = m.savedCandidates || [];
      state.installCandidates = m.installCandidates || [];
      render();
    } else if (m.type === "browsed") {
      if (m.which === "saved") state.savedGames = m.path;
      else if (m.which === "data") state.dataDir = m.path;
      else state.gameInstall = m.path;
      render();
    } else if (m.type === "saved") {
      const note = document.getElementById("savedNote");
      if (note) {
        note.style.display = "inline";
        setTimeout(() => (note.style.display = "none"), 2000);
      }
    }
  });

  render();
})();
