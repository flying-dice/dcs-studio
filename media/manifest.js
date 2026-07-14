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

  const { ROOT_TOKENS, MISSION_SCRIPT_RUN_ON, parseToml, emitToml, splitDest } = self.DcsManifestCore;
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
  /** A symlink source is covered when it equals or nests inside a bundle path. */
  function coveredByBundle(source, bundlePaths) {
    const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "");
    const s = norm(source);
    return bundlePaths.some((p) => {
      const b = norm(p);
      return b === "" || b === "." || s === b || s.startsWith(b + "/");
    });
  }

  function issues(m) {
    const out = [];
    if (!m.project.name.trim()) out.push("Project name is required.");
    const bundlePaths = m.bundle.map((b) => b.path);
    m.bundle.forEach((r, i) => {
      if (!r.path.trim()) out.push(`Bundle ${i + 1}: path is empty.`);
    });
    m.symlink.forEach((r, i) => {
      if (!r.source.trim()) out.push(`Symlink ${i + 1}: source is empty.`);
      else if (!coveredByBundle(r.source, bundlePaths))
        out.push(`Symlink ${i + 1}: source is not inside any bundled path.`);
      if (splitDest(r.dest).root === "{GameInstall}" && !roots.gameInstall)
        out.push(`Symlink ${i + 1}: {GameInstall} is not configured (set dcsStudio.gameInstallPath).`);
    });
    m.requires_module.forEach((r, i) => {
      if (!r.id.trim()) out.push(`Required module ${i + 1}: id is empty.`);
    });
    const epIds = m.entrypoint.map((e) => e.id);
    m.entrypoint.forEach((r, i) => {
      if (!r.id.trim()) out.push(`Executable ${i + 1}: id is empty.`);
      else if (epIds.indexOf(r.id) !== i) out.push(`Executable ${i + 1}: duplicate id "${r.id}".`);
      if (!r.exe.trim()) out.push(`Executable ${i + 1}: exe is empty.`);
      else if (!coveredByBundle(r.exe, bundlePaths))
        out.push(`Executable ${i + 1}: exe is not inside any bundled path.`);
    });
    m.mission_script.forEach((r, i) => {
      if (!r.name.trim()) out.push(`Mission script ${i + 1}: name is empty.`);
      if (!r.path.trim()) out.push(`Mission script ${i + 1}: path is empty.`);
      else if (!coveredByBundle(r.path, bundlePaths))
        out.push(`Mission script ${i + 1}: path is not inside any bundled path.`);
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
          ${sectionBundle(m)}
          ${sectionSymlink(m)}
          ${sectionEntrypoint(m)}
          ${sectionMissionScript(m)}
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
    bundle: "add-bundle-btn",
    symlink: "add-symlink-btn",
    requires_module: "add-required-module-btn",
    entrypoint: "add-entrypoint-btn",
    mission_script: "add-mission-script-btn",
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

  function sectionBundle(m) {
    const rows = m.bundle
      .map(
        (r, i) => `
        <div class="row" data-testid="bundle-row" data-row="bundle-${i}">
          <div class="row-grid two">
            ${fieldRow("Path", "project-relative", input("bundle", i, "path", r.path, "Mods/tech/my-mod"))}
          </div>
          <button class="rm" data-testid="remove-row-btn" data-rm="bundle" data-idx="${i}" title="Remove path">${I.x}</button>
        </div>`,
      )
      .join("");
    return `
      <section class="card">
        <div class="section-label">[[bundle]] <span class="count">${m.bundle.length}</span></div>
        <p class="blurb">Each entry is a project-relative <span class="mono">path</span> (file or folder) packed into the release archive when you publish.</p>
        ${rows || `<p class="empty">No bundled content yet.</p>`}
        <button class="btn ghost add" data-testid="${ADD_TESTID.bundle}" data-add="bundle">${I.plus} Add bundled path</button>
      </section>`;
  }

  function sectionSymlink(m) {
    const rows = m.symlink
      .map((r, i) => {
        const { root, rest } = splitDest(r.dest);
        const resolved = resolveDest(r.dest);
        return `
        <div class="row" data-testid="symlink-row" data-row="symlink-${i}">
          <div class="row-grid">
            ${fieldRow("Source", "inside a bundled path", input("symlink", i, "source", r.source, "Mods/tech/my-mod/entry.lua"))}
            <label class="field">
              <span class="lbl">Destination</span>
              <span class="dest">
                <select class="in root" data-sec="symlink" data-idx="${i}" data-key="__root">
                  ${ROOT_TOKENS.map((t) => `<option ${t === root ? "selected" : ""}>${t}</option>`).join("")}
                </select>
                <input class="in" data-sec="symlink" data-idx="${i}" data-key="__rest" value="${esc(rest)}" placeholder="Scripts/my-mod" spellcheck="false" autocomplete="off" />
              </span>
            </label>
          </div>
          <div class="resolved mono" data-testid="resolved-dest">${I.arrow}${resolved ? esc(resolved) : `<span class="warn-text" data-testid="unresolved-warning">${I.warn} {GameInstall} not configured</span>`}</div>
          <button class="rm" data-testid="remove-row-btn" data-rm="symlink" data-idx="${i}" title="Remove link">${I.x}</button>
        </div>`;
      })
      .join("");
    return `
      <section class="card">
        <div class="section-label">[[symlink]] <span class="count">${m.symlink.length}</span></div>
        <p class="blurb">Each link maps a <span class="mono">source</span> inside the bundled content to a root-anchored <span class="mono">dest</span>, created when a user enables the mod. The resolved path shows where it lands on this machine.</p>
        ${rows || `<p class="empty">No symlinks yet.</p>`}
        <button class="btn ghost add" data-testid="${ADD_TESTID.symlink}" data-add="symlink">${I.plus} Add symlink</button>
      </section>`;
  }

  function sectionEntrypoint(m) {
    const rows = m.entrypoint
      .map(
        (r, i) => `
        <div class="row" data-testid="entrypoint-row" data-row="entrypoint-${i}">
          <div class="row-grid two">
            ${fieldRow("Id", "unique slug", input("entrypoint", i, "id", r.id, "srs-server"))}
            ${fieldRow("Name", "shown in My Mods", input("entrypoint", i, "name", r.name, "SRS Server"))}
          </div>
          <div class="row-grid two">
            ${fieldRow("Executable", "inside a bundled path", input("entrypoint", i, "exe", r.exe, "Server/SR-Server.exe"))}
            ${fieldRow("Working dir", "optional; defaults to the exe's folder", input("entrypoint", i, "cwd", r.cwd || "", "Server"))}
          </div>
          <label class="field">
            <span class="lbl">Arguments<span class="hint">one per line; {SavedGames}/{GameInstall} expanded at launch</span></span>
            <textarea class="in" data-testid="entrypoint-args" data-sec="entrypoint" data-idx="${i}" data-key="__args" rows="2" spellcheck="false" placeholder="--minimized">${esc((r.args || []).join("\n"))}</textarea>
          </label>
          <button class="rm" data-testid="remove-row-btn" data-rm="entrypoint" data-idx="${i}" title="Remove executable">${I.x}</button>
        </div>`,
      )
      .join("");
    return `
      <section class="card">
        <div class="section-label">[[entrypoint]] <span class="count">${m.entrypoint.length}</span></div>
        <p class="blurb">Executables the mod can launch as tracked processes from <span class="mono">My Mods</span>. Each <span class="mono">exe</span> is a path inside the bundled content; the first launch asks the user to confirm.</p>
        ${rows || `<p class="empty">No executables.</p>`}
        <button class="btn ghost add" data-testid="${ADD_TESTID.entrypoint}" data-add="entrypoint">${I.plus} Add executable</button>
      </section>`;
  }

  function sectionMissionScript(m) {
    const rows = m.mission_script
      .map((r, i) => {
        const before = r.run_on === "before-sanitize";
        return `
        <div class="row" data-testid="mission-script-row" data-row="mission_script-${i}">
          <div class="row-grid two">
            ${fieldRow("Name", "shown to subscribers", input("mission_script", i, "name", r.name, "My Framework loader"))}
            ${fieldRow("Purpose", "optional; one line", input("mission_script", i, "purpose", r.purpose || "", "Boots the framework"))}
          </div>
          <div class="row-grid two">
            ${fieldRow("Path", "inside a bundled path", input("mission_script", i, "path", r.path, "Scripts/my-framework/loader.lua"))}
            <label class="field">
              <span class="lbl">Run on<span class="hint">before or after the sanitize lockdown</span></span>
              <select class="in" data-sec="mission_script" data-idx="${i}" data-key="run_on">
                ${MISSION_SCRIPT_RUN_ON.map((t) => `<option value="${t}" ${t === r.run_on ? "selected" : ""}>${t}</option>`).join("")}
              </select>
            </label>
          </div>
          ${
            before
              ? `<div class="resolved warn-text" data-testid="before-sanitize-warning">${I.warn} Runs with the FULL unsanitized Lua environment (os/io/lfs/require) — arbitrary file and process access. Subscribers are warned before installing.</div>`
              : ""
          }
          <button class="rm" data-testid="remove-row-btn" data-rm="mission_script" data-idx="${i}" title="Remove mission script">${I.x}</button>
        </div>`;
      })
      .join("");
    return `
      <section class="card">
        <div class="section-label">[[mission_script]] <span class="count">${m.mission_script.length}</span></div>
        <p class="blurb">Lua scripts run at mission start via DCS Studio's managed <span class="mono">MissionScripting.lua</span> entrypoint. Each <span class="mono">path</span> is inside the bundled content. <span class="mono">before-sanitize</span> scripts run with the full unsanitized Lua environment — use only when a mod genuinely needs <span class="mono">os</span>/<span class="mono">io</span>/<span class="mono">lfs</span>.</p>
        ${rows || `<p class="empty">No mission scripts.</p>`}
        <button class="btn ghost add" data-testid="${ADD_TESTID.mission_script}" data-add="mission_script">${I.plus} Add mission script</button>
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
          const row = state.model.symlink[i];
          const parts = splitDest(row.dest);
          const rootTok = key === "__root" ? el.value : parts.root;
          const rest = key === "__rest" ? el.value : parts.rest;
          row.dest = rest ? `${rootTok}/${rest.replace(/^\/+/, "")}` : rootTok;
          updateResolved(i);
        } else if (key === "__args") {
          // One arg per line; blank lines dropped. Keeps args that contain spaces.
          state.model.entrypoint[i].args = el.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        } else if (sec === "mission_script" && key === "run_on") {
          // Full render so the before-sanitize warning marker toggles live.
          state.model.mission_script[i].run_on = el.value;
          render();
          pushEdit();
          return;
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
        if (sec === "bundle") state.model.bundle.push({ path: "" });
        else if (sec === "symlink") state.model.symlink.push({ source: "", dest: "{SavedGames}/Scripts/" });
        else if (sec === "requires_module") state.model.requires_module.push({ id: "", name: "" });
        else if (sec === "entrypoint") state.model.entrypoint.push({ id: "", name: "", exe: "" });
        else if (sec === "mission_script")
          state.model.mission_script.push({ name: "", purpose: "", path: "", run_on: "after-sanitize" });
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
    const row = app.querySelector(`[data-row="symlink-${i}"] .resolved`);
    if (!row) return;
    const resolved = resolveDest(state.model.symlink[i].dest);
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
