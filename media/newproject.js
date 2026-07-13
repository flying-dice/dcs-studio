// @ts-nocheck
// The guided New Project experience: template tiles + name + destination with
// a live path preview. With a folder open it bootstraps that folder in place
// by default; otherwise it asks where to create the project. The host
// scaffolds and opens the result.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");

  const state = {
    templates: [],
    templateId: "",
    name: "",
    location: "",
    folder: null, // open workspace folder (in-place target), or null
    inPlace: false,
    sep: "\\",
    creating: false,
    error: "",
  };

  // Icons keyed by template id (same stroke style as nav.js).
  const ICONS = {
    "blank": `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>`,
    "lua-mission": `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"/></svg>`,
    "lua-hook": `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="3"/><path d="M12 22V8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/></svg>`,
    "rust-dll": `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>`,
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]),
    );
  }

  function previewPath() {
    if (state.inPlace) return state.folder || "";
    if (!state.location || !state.name.trim()) return "";
    const loc = state.location.replace(/[\\/]+$/, "");
    return `${loc}${state.sep}${state.name.trim()}`;
  }

  function canCreate() {
    if (state.creating || !state.name.trim()) return false;
    return state.inPlace ? !!state.folder : !!state.location;
  }

  function tileHtml(t) {
    const sel = t.id === state.templateId ? " selected" : "";
    return `
      <button class="tile${sel}" data-template="${esc(t.id)}">
        <span class="tichip">${ICONS[t.id] || ICONS["blank"]}</span>
        <span class="ttxt">
          <span class="tlabel">${esc(t.label)}</span>
          <span class="tdesc">${esc(t.description)}</span>
        </span>
      </button>`;
  }

  function destinationHtml() {
    const modes = state.folder
      ? `
      <div class="modes">
        <label class="mode">
          <input type="radio" name="mode" value="inplace" ${state.inPlace ? "checked" : ""} />
          <span class="mtxt">
            <span class="mlabel">Use the open folder</span>
            <span class="mdesc mono" title="${esc(state.folder)}">${esc(state.folder)}</span>
          </span>
        </label>
        <label class="mode">
          <input type="radio" name="mode" value="newfolder" ${state.inPlace ? "" : "checked"} />
          <span class="mtxt">
            <span class="mlabel">Create a new folder</span>
            <span class="mdesc">A fresh folder under a location you pick, opened when ready.</span>
          </span>
        </label>
      </div>`
      : "";
    const locationField = state.inPlace
      ? ""
      : `
      <div class="field">
        <label class="lbl" for="locBtn">Location</label>
        <div class="pathrow">
          <button id="locBtn" class="loc" title="${esc(state.location)}">
            <span class="locpath ${state.location ? "" : "placeholder"}">${esc(state.location || "Choose where to create the project…")}</span>
          </button>
          <button id="browse" class="btn secondary">Browse…</button>
        </div>
      </div>`;
    return `${modes}
      <div class="grid2">
        <div class="field">
          <label class="lbl" for="name">Name</label>
          <input id="name" class="in" value="${esc(state.name)}" placeholder="my-script-mod" spellcheck="false" autocomplete="off" />
        </div>
        ${locationField}
      </div>`;
  }

  function render() {
    const preview = previewPath();
    app.innerHTML = `
      <header>
        <div class="titles">
          <span class="kicker">DCS&nbsp;Studio</span>
          <span class="title">New Project</span>
        </div>
      </header>
      <div class="wrap">
        <p class="intro">Scaffold a DCS World mod from a template — manifest, entry point and install rules included. Files are only written where shown below; nothing installs into DCS until you say so.</p>

        <section class="card">
          <h2>Template</h2>
          <p class="sub">What the project starts with — you can change anything afterwards.</p>
          <div class="tiles">
            ${state.templates.map(tileHtml).join("")}
          </div>
        </section>

        <section class="card">
          <h2>Destination</h2>
          <p class="sub">${state.inPlace ? "The template is bootstrapped into the open folder; files you already have are kept." : "The project is created as a new folder and opened in this window."}</p>
          ${destinationHtml()}
          <div class="preview mono ${preview ? "" : "empty"}">${preview ? "&rarr; " + esc(preview) : "&nbsp;"}</div>
          ${state.error ? `<div class="error">${esc(state.error)}</div>` : ""}
          <div class="actions">
            <button id="create" class="btn" ${canCreate() ? "" : "disabled"}>
              ${state.creating ? `<span class="spin">◌</span> Creating…` : "Create Project"}
            </button>
          </div>
        </section>
      </div>
    `;
    wire();
  }

  function wire() {
    app.querySelectorAll(".tile").forEach((el) => {
      el.addEventListener("click", () => {
        state.templateId = el.dataset.template;
        state.error = "";
        render();
      });
    });
    app.querySelectorAll('input[name="mode"]').forEach((el) => {
      el.addEventListener("change", () => {
        state.inPlace = el.value === "inplace" && el.checked;
        state.error = "";
        render();
      });
    });
    const name = document.getElementById("name");
    name.addEventListener("input", () => {
      state.name = name.value;
      state.error = "";
      // Update the dependent bits in place; a full render would drop focus.
      const p = previewPath();
      const pv = app.querySelector(".preview");
      pv.classList.toggle("empty", !p);
      pv.innerHTML = p ? "&rarr; " + esc(p) : "&nbsp;";
      document.getElementById("create").disabled = !canCreate();
      const err = app.querySelector(".error");
      if (err) err.remove();
    });
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && canCreate()) create();
    });
    const browse = () => vscode.postMessage({ type: "browse", location: state.location });
    const locBtn = document.getElementById("locBtn");
    if (locBtn) locBtn.addEventListener("click", browse);
    const browseBtn = document.getElementById("browse");
    if (browseBtn) browseBtn.addEventListener("click", browse);
    document.getElementById("create").addEventListener("click", create);
  }

  function create() {
    if (!canCreate()) return;
    state.creating = true;
    state.error = "";
    render();
    vscode.postMessage({
      type: "create",
      template: state.templateId,
      name: state.name.trim(),
      location: state.location,
      inPlace: state.inPlace,
    });
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === "init") {
      state.creating = false;
      state.error = "";
      state.templates = m.templates || [];
      state.templateId = state.templates[0] ? state.templates[0].id : "";
      state.folder = m.folder || null;
      state.inPlace = !!state.folder;
      state.location = m.location || "";
      state.name = m.name || "";
      state.sep = m.sep || "\\";
      render();
      const name = document.getElementById("name");
      if (name) name.focus();
    } else if (m.type === "browsed") {
      state.location = m.path;
      state.error = "";
      render();
    } else if (m.type === "error") {
      state.creating = false;
      state.error = m.message || "Something went wrong.";
      render();
    } else if (m.type === "created") {
      state.creating = false;
    }
  });
})();
