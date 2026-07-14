// @ts-nocheck
// Publish panel: preflight checks, Share to GitHub (repo + push), Create a release
// (7z-packaged, volume-split payload + standalone manifest).
(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const state = {
    checks: [],
    repo: null,
    defaults: { name: "", description: "", version: "0.1.0" },
  };

  const { esc } = dcsUi;
  const blocking = () => state.checks.some((c) => c.level === "error");

  function checksHtml() {
    return `<div class="checks">${state.checks
      .map((c) => {
        const row = `<div class="check"><span class="cdot ${c.level}"></span><span class="clabel">${esc(c.label)}</span><span class="cdetail" title="${esc(c.detail)}">${esc(c.detail)}</span></div>`;
        const items = (c.items || [])
          .map((it) => `<div class="citem ${c.level}" title="${esc(it)}">${esc(it)}</div>`)
          .join("");
        return row + items;
      })
      .join("")}</div>`;
  }

  function render() {
    const tag = `v${state.defaults.version || "0.1.0"}`;
    const shared = !!state.repo;
    app.innerHTML = `
      <header>
        <div style="display:flex;flex-direction:column;line-height:1.2">
          <span class="kicker">DCS&nbsp;Studio</span><span class="title">Publish Mod</span>
        </div>
        <span class="spacer"></span>
        <button class="btn secondary" id="refresh" style="margin:0">Re-check</button>
      </header>
      <div class="wrap">
        <section class="card">
          <h2>Preflight checks</h2>
          <p class="sub">These must pass before a release. Build your project so the <span class="mono">[[bundle]]</span> paths exist.</p>
          ${checksHtml()}
          ${blocking() ? `<div class="blocked">Resolve the red items above to publish.</div>` : ""}
        </section>

        <section class="card">
          <h2>1 · Share to GitHub</h2>
          <p class="sub">Creates a public repo, pushes your project, and tags it <span class="mono">dcs-studio</span> so the Marketplace can discover it.</p>
          ${
            shared
              ? `<div class="result ok">Already on GitHub: <button class="btn link" data-open="${esc(state.repo.owner)}/${esc(state.repo.name)}">${esc(state.repo.owner)}/${esc(state.repo.name)}</button>. You can re-push by sharing again.</div>`
              : ""
          }
          <div class="grid2" style="margin-top:12px">
            <div class="field"><span class="lbl">Repository name</span><input class="in" id="repoName" value="${esc(state.repo ? state.repo.name : state.defaults.name)}" placeholder="my-cool-mod" spellcheck="false" /></div>
            <div class="field"><span class="lbl">Description</span><input class="in" id="repoDesc" value="${esc(state.defaults.description)}" placeholder="One line about the mod" spellcheck="false" /></div>
          </div>
          <button class="btn" id="shareBtn" ${blocking() ? "disabled" : ""}>Share to GitHub</button>
          <div class="result ok" id="shareResult" style="display:none"></div>
        </section>

        <section class="card">
          <h2>2 · Create a release</h2>
          <p class="sub">Packages the manifest + install sources into a 7z payload (split into GitHub-safe volumes when large) and uploads it with the standalone <span class="mono">dcs-studio.toml</span> alongside.</p>
          <div class="grid2">
            <div class="field"><span class="lbl">Repo (owner/name)</span><input class="in" id="relRepo" value="${esc(state.repo ? `${state.repo.owner}/${state.repo.name}` : "")}" placeholder="owner/name" spellcheck="false" /></div>
            <div class="field"><span class="lbl">Tag</span><input class="in" id="relTag" value="${esc(tag)}" placeholder="v1.0.0" spellcheck="false" /></div>
            <div class="field full"><span class="lbl">Release notes</span><textarea class="in" id="relNotes" placeholder="What changed in this release…"></textarea></div>
          </div>
          <button class="btn" id="releaseBtn" ${blocking() ? "disabled" : ""}>Package &amp; publish release</button>
          <div class="result ok" id="releaseResult" style="display:none"></div>
        </section>

        <div class="log" id="log"></div>
      </div>
    `;
    bind();
  }

  function bind() {
    document
      .getElementById("refresh")
      .addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    document.querySelectorAll("[data-open]").forEach((el) => {
      el.addEventListener("click", () =>
        vscode.postMessage({
          type: "openExternal",
          url: `https://github.com/${el.dataset.open}`,
        }),
      );
    });
    const shareBtn = document.getElementById("shareBtn");
    shareBtn.addEventListener("click", () => {
      showLog();
      vscode.postMessage({
        type: "share",
        opts: {
          name: document.getElementById("repoName").value.trim(),
          description: document.getElementById("repoDesc").value.trim(),
        },
      });
    });
    const releaseBtn = document.getElementById("releaseBtn");
    releaseBtn.addEventListener("click", () => {
      const repo = document.getElementById("relRepo").value.trim();
      const [owner, name] = repo.split("/");
      if (!owner || !name) {
        appendLog("✖ Enter the repo as owner/name (share first if you haven't).");
        showLog();
        return;
      }
      showLog();
      vscode.postMessage({
        type: "release",
        opts: {
          owner,
          name,
          tag: document.getElementById("relTag").value.trim(),
          notes: document.getElementById("relNotes").value,
        },
      });
    });
  }

  const logEl = () => document.getElementById("log");
  function showLog() {
    logEl().classList.add("show");
  }
  function appendLog(line) {
    const el = logEl();
    el.textContent += (el.textContent ? "\n" : "") + line;
    el.scrollTop = el.scrollHeight;
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m) return;
    switch (m.type) {
      case "nofolder":
        app.innerHTML = `<div class="wrap"><section class="card"><h2>Open a project folder</h2><p class="sub">Publish works on the open workspace folder that holds your dcs-studio.toml.</p></section></div>`;
        break;
      case "init":
        state.checks = m.checks;
        state.repo = m.repo;
        state.defaults = m.defaults;
        render();
        break;
      case "log":
        appendLog(m.line);
        break;
      case "busy": {
        const btn = document.getElementById(m.scope === "share" ? "shareBtn" : "releaseBtn");
        if (btn) {
          btn.disabled = m.busy;
          btn.textContent = m.busy
            ? m.scope === "share"
              ? "Sharing…"
              : "Publishing…"
            : m.scope === "share"
              ? "Share to GitHub"
              : "Package & publish release";
        }
        break;
      }
      case "shareDone": {
        const r = document.getElementById("shareResult");
        r.style.display = "block";
        r.innerHTML = `Shared → <button class="btn link" data-open="${esc(m.result.owner)}/${esc(m.result.name)}">${esc(m.result.owner)}/${esc(m.result.name)}</button>. Create a release below.`;
        r.querySelector("[data-open]").addEventListener("click", (ev) =>
          vscode.postMessage({
            type: "openExternal",
            url: `https://github.com/${ev.target.dataset.open}`,
          }),
        );
        const relRepo = document.getElementById("relRepo");
        if (relRepo && !relRepo.value) relRepo.value = `${m.result.owner}/${m.result.name}`;
        appendLog(`✓ Shared to ${m.result.owner}/${m.result.name}`);
        break;
      }
      case "releaseDone": {
        const r = document.getElementById("releaseResult");
        r.style.display = "block";
        r.innerHTML = `Published release <span class="mono">${esc(m.result.url.split("/").pop())}</span> · <button class="btn link" data-url="${esc(m.result.url)}">view on GitHub</button><div class="assets">${m.result.assets.map(esc).join("<br>")}</div>`;
        r.querySelector("[data-url]").addEventListener("click", (ev) =>
          vscode.postMessage({ type: "openExternal", url: ev.target.dataset.url }),
        );
        appendLog(`✓ Release published: ${m.result.url}`);
        break;
      }
    }
  });

  vscode.postMessage({ type: "refresh" });
})();
