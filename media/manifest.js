// @ts-nocheck
// dcs-studio.toml authoring form — the body of the custom text editor. The open
// document is the source of truth: every change emits TOML and posts an {edit}
// the host applies as a WorkspaceEdit (so Ctrl/Cmd+S, dirty state and undo are
// VS Code's). External changes arrive as {external} and re-seed the form. Pure
// parse/emit/resolve come from the shared, unit-tested core (manifest-core.js).
(function () {
  const vscode = acquireVsCodeApi();
  const boot = window.__BOOTSTRAP__;
  const app = document.getElementById("app");

  const { ROOT_TOKENS, parseToml, emitToml, splitDest } = self.DcsManifestCore;
  let roots = boot.roots;
  const resolveDest = (dest) => self.DcsManifestCore.resolveDest(dest, roots);

  const state = { model: parseToml(boot.rawText) };

  // ── Edit propagation (debounced so a keystroke isn't one undo step each) ──
  let editTimer = null;
  function pushEdit() {
    if (editTimer) clearTimeout(editTimer);
    editTimer = setTimeout(() => {
      editTimer = null;
      vscode.postMessage({ type: "edit", text: emitToml(state.model) });
    }, 200);
  }
  /** Model changed via the form: refresh preview + push the edit to the document. */
  function changed() {
    renderPreview();
    pushEdit();
  }

  // ── Validation ──
  function issues(m) {
    const out = [];
    if (!m.project.name.trim()) out.push("Project name is required.");
    m.install.forEach((r, i) => {
      if (!r.source.trim()) out.push(`Install rule ${i + 1}: source is empty.`);
      if (splitDest(r.dest).root === "{GameInstall}" && !roots.gameInstall)
        out.push(`Install rule ${i + 1}: {GameInstall} is not configured (set dcsStudio.gameInstallPath).`);
    });
    m.dependencies.forEach((d, i) => {
      if (!d.id.trim()) out.push(`Dependency ${i + 1}: id (owner/repo) is empty.`);
      else if (!/^[^/]+\/[^/]+$/.test(d.id.trim())) out.push(`Dependency ${i + 1}: id should look like owner/repo.`);
    });
    m.requires_module.forEach((r, i) => {
      if (!r.id.trim()) out.push(`Required module ${i + 1}: id is empty.`);
    });
    return out;
  }

  // ── Icons ──
  const I = {
    plus: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
    x: `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
    arrow: `<svg class="ico sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
    warn: `<svg class="ico sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>`,
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
    );
  }

  // ── Render ──
  function render() {
    const m = state.model;
    const extras = m.extras && m.extras.length;
    app.innerHTML = `
      <header>
        <div class="titles">
          <span class="kicker">DCS&nbsp;Studio</span>
          <span class="title">Manifest form — <span class="mono">${esc(baseName(boot.targetPath))}</span></span>
        </div>
        <span class="spacer"></span>
        <span class="save-hint mono">two-way bound to the editor · ⌘/Ctrl&nbsp;S to save</span>
      </header>

      <div class="layout">
        <div class="form" id="form">
          ${sectionProject(m)}
          ${sectionInstall(m)}
          ${sectionDeps(m)}
          ${sectionRequires(m)}
          ${extras ? passthroughNote(m) : ""}
        </div>

        <aside class="preview">
          <div class="preview-head">
            <span class="section-label">Document</span>
            <span class="target mono">${esc(baseName(boot.targetPath))}</span>
          </div>
          <pre class="toml" id="toml" data-testid="toml-preview"></pre>
          <div id="issues"></div>
        </aside>
      </div>
    `;
    bind();
    renderPreview();
  }

  function passthroughNote(m) {
    return `
      <section class="card muted-card">
        <div class="section-label">Preserved sections</div>
        <p class="blurb">This file has ${m.extras.length} section${m.extras.length === 1 ? "" : "s"} the form doesn't edit (e.g. <span class="mono">[format]</span>, <span class="mono">[lints]</span>). They're kept exactly as written and saved back untouched.</p>
      </section>`;
  }

  function baseName(p) {
    if (!p) return "dcs-studio.toml";
    return p.split(/[\\/]/).pop();
  }

  function fieldRow(label, hint, inner) {
    return `<label class="field"><span class="lbl">${esc(label)}${hint ? `<span class="hint">${esc(hint)}</span>` : ""}</span>${inner}</label>`;
  }
  function input(sec, idx, key, value, ph) {
    return `<input class="in" data-testid="manifest-input" data-sec="${sec}" data-idx="${idx}" data-key="${key}" value="${esc(value)}" placeholder="${esc(ph || "")}" spellcheck="false" autocomplete="off" />`;
  }

  // data-add -> data-testid, per the previews/ data-testid convention doc.
  const ADD_TESTID = {
    install: "add-install-btn",
    dependencies: "add-dependency-btn",
    requires_module: "add-required-module-btn",
  };

  function sectionProject(m) {
    return `
      <section class="card">
        <div class="section-label">[project]</div>
        <div class="grid2">
          ${fieldRow("Name", "required", input("project", -1, "name", m.project.name, "my-cool-mod"))}
          ${fieldRow("Version", "", input("project", -1, "version", m.project.version, "0.1.0"))}
          ${fieldRow("Author", "", input("project", -1, "author", m.project.author, "your-github-handle"))}
          ${fieldRow("Description", "", input("project", -1, "description", m.project.description, "One line about the mod"))}
        </div>
      </section>`;
  }

  function sectionInstall(m) {
    const rows = m.install
      .map((r, i) => {
        const { root, rest } = splitDest(r.dest);
        const resolved = resolveDest(r.dest);
        return `
        <div class="row" data-testid="install-row" data-row="install-${i}">
          <div class="row-grid">
            ${fieldRow("Source", "project-relative", input("install", i, "source", r.source, "dist/scripts"))}
            <label class="field">
              <span class="lbl">Destination</span>
              <span class="dest">
                <select class="in root" data-sec="install" data-idx="${i}" data-key="__root">
                  ${ROOT_TOKENS.map((t) => `<option ${t === root ? "selected" : ""}>${t}</option>`).join("")}
                </select>
                <input class="in" data-sec="install" data-idx="${i}" data-key="__rest" value="${esc(rest)}" placeholder="Scripts/my-mod" spellcheck="false" autocomplete="off" />
              </span>
            </label>
          </div>
          <div class="resolved mono" data-testid="resolved-dest">${I.arrow}${resolved ? esc(resolved) : `<span class="warn-text" data-testid="unresolved-warning">${I.warn} {GameInstall} not configured</span>`}</div>
          <button class="rm" data-testid="remove-row-btn" data-rm="install" data-idx="${i}" title="Remove rule">${I.x}</button>
        </div>`;
      })
      .join("");
    return `
      <section class="card">
        <div class="section-label">[[install]] <span class="count">${m.install.length}</span></div>
        <p class="blurb">Each rule copies a project-relative <span class="mono">source</span> under a root-anchored <span class="mono">dest</span>. The resolved path shows where it lands on this machine.</p>
        ${rows || `<p class="empty">No install rules yet.</p>`}
        <button class="btn ghost add" data-testid="${ADD_TESTID.install}" data-add="install">${I.plus} Add install rule</button>
      </section>`;
  }

  function sectionDeps(m) {
    const rows = m.dependencies
      .map(
        (d, i) => `
        <div class="row" data-testid="dep-row" data-row="dep-${i}">
          <div class="row-grid four">
            ${fieldRow("Id", "owner/repo", input("dependencies", i, "id", d.id, "owner/repo"))}
            ${fieldRow("Name", "optional", input("dependencies", i, "name", d.name, "Display name"))}
            ${fieldRow("Version", "optional", input("dependencies", i, "version", d.version, "* or ^1.0"))}
            <label class="field check">
              <input type="checkbox" data-sec="dependencies" data-idx="${i}" data-key="optional" ${d.optional ? "checked" : ""} />
              <span class="lbl">optional</span>
            </label>
          </div>
          <button class="rm" data-testid="remove-row-btn" data-rm="dependencies" data-idx="${i}" title="Remove dependency">${I.x}</button>
        </div>`,
      )
      .join("");
    return `
      <section class="card">
        <div class="section-label">[[dependencies]] <span class="count">${m.dependencies.length}</span></div>
        <p class="blurb">Other Marketplace mods (by <span class="mono">owner/repo</span>) installed transitively with this one.</p>
        ${rows || `<p class="empty">No dependencies.</p>`}
        <button class="btn ghost add" data-testid="${ADD_TESTID.dependencies}" data-add="dependencies">${I.plus} Add dependency</button>
      </section>`;
  }

  function sectionRequires(m) {
    const rows = m.requires_module
      .map(
        (r, i) => `
        <div class="row" data-testid="req-row" data-row="req-${i}">
          <div class="row-grid two">
            ${fieldRow("Module id", "stock DCS module", input("requires_module", i, "id", r.id, "F-16C_50"))}
            ${fieldRow("Name", "optional", input("requires_module", i, "name", r.name, "F-16C Viper"))}
          </div>
          <button class="rm" data-testid="remove-row-btn" data-rm="requires_module" data-idx="${i}" title="Remove requirement">${I.x}</button>
        </div>`,
      )
      .join("");
    return `
      <section class="card">
        <div class="section-label">[[requires_module]] <span class="count">${m.requires_module.length}</span></div>
        <p class="blurb">Stock DCS modules the user must already own. A presence check only — never installed, only warned about.</p>
        ${rows || `<p class="empty">No required modules.</p>`}
        <button class="btn ghost add" data-testid="${ADD_TESTID.requires_module}" data-add="requires_module">${I.plus} Add required module</button>
      </section>`;
  }

  // ── Events ──
  function bind() {
    app.querySelectorAll(".in").forEach((el) => {
      const ev = el.tagName === "SELECT" ? "change" : "input";
      el.addEventListener(ev, () => {
        const { sec, idx, key } = el.dataset;
        const i = parseInt(idx, 10);
        if (sec === "project") state.model.project[key] = el.value;
        else if (key === "__root" || key === "__rest") {
          const row = state.model.install[i];
          const parts = splitDest(row.dest);
          const rootTok = key === "__root" ? el.value : parts.root;
          const rest = key === "__rest" ? el.value : parts.rest;
          row.dest = rest ? `${rootTok}/${rest.replace(/^\/+/, "")}` : rootTok;
          updateResolved(i);
        } else state.model[sec][i][key] = el.value;
        changed();
      });
    });
    app.querySelectorAll('input[type="checkbox"]').forEach((el) => {
      el.addEventListener("change", () => {
        const { sec, idx, key } = el.dataset;
        state.model[sec][parseInt(idx, 10)][key] = el.checked;
        changed();
      });
    });
    app.querySelectorAll("[data-add]").forEach((el) =>
      el.addEventListener("click", () => {
        const sec = el.dataset.add;
        if (sec === "install") state.model.install.push({ source: "", dest: "{SavedGames}/Scripts/" });
        else if (sec === "dependencies")
          state.model.dependencies.push({ id: "", name: "", version: "", optional: false });
        else if (sec === "requires_module") state.model.requires_module.push({ id: "", name: "" });
        render();
        pushEdit();
      }),
    );
    app.querySelectorAll("[data-rm]").forEach((el) =>
      el.addEventListener("click", () => {
        state.model[el.dataset.rm].splice(parseInt(el.dataset.idx, 10), 1);
        render();
        pushEdit();
      }),
    );
  }

  function updateResolved(i) {
    const row = app.querySelector(`[data-row="install-${i}"] .resolved`);
    if (!row) return;
    const resolved = resolveDest(state.model.install[i].dest);
    row.innerHTML = resolved
      ? I.arrow + esc(resolved)
      : `<span class="warn-text" data-testid="unresolved-warning">${I.warn} {GameInstall} not configured</span>`;
  }

  function renderPreview() {
    document.getElementById("toml").textContent = emitToml(state.model);
    const probs = issues(state.model);
    const box = document.getElementById("issues");
    box.innerHTML = probs.length
      ? `<ul class="issues" data-testid="validation-issues">${probs.map((p) => `<li>${I.warn}${esc(p)}</li>`).join("")}</ul>`
      : `<p class="ok" data-testid="validation-ok">Manifest looks valid.</p>`;
  }

  // ── Host → webview ──
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === "external") {
      // The document changed outside the form (raw-text edit, undo, revert).
      state.model = parseToml(m.rawText);
      render();
    } else if (m.type === "roots") {
      roots = m.roots;
      render();
    }
  });

  render();
})();
