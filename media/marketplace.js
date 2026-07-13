// @ts-nocheck
// Storefront SPA. The webview owns view state (grid, product page, search/tag/
// sort); the extension host owns GitHub (auth, topic discovery, product loads)
// and answers messages. Sign-in gated with a browse-without-signing-in fallback,
// mirroring dcs-studio's /marketplace.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");

  const persisted = vscode.getState() || {};
  const state = {
    // auth
    signedIn: false,
    browsing: false,
    login: null,
    topic: "dcs-studio",
    authKnown: false,
    // listings
    listings: [],
    listBusy: false,
    listError: null,
    // product
    view: persisted.view || "list",
    repo: persisted.repo || null,
    product: null,
    productBusy: false,
    productError: null,
    plan: null,
    installed: false,
    installing: null,
    installError: null,
    // filters
    query: "",
    activeTag: "",
    sort: "stars",
  };

  const post = (m) => vscode.postMessage(m);
  const save = () => vscode.setState({ view: state.view, repo: state.repo });

  // ── Icons ──
  const I = {
    search: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`,
    star: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15 9 22 9.3 16.5 14 18.5 21 12 17 5.5 21 7.5 14 2 9.3 9 9"/></svg>`,
    tag: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.6 2.6 21 11a2 2 0 0 1 0 2.8l-6.2 6.2a2 2 0 0 1-2.8 0L3.6 11.6A2 2 0 0 1 3 10.2V4a1 1 0 0 1 1-1h6.2a2 2 0 0 1 1.4.6Z"/><circle cx="7.5" cy="7.5" r="1"/></svg>`,
    back: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>`,
    refresh: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>`,
    ext: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`,
    download: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>`,
    check: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
    hd: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 18h.01M10 18h.01"/><path d="m6 14 3-9h6l3 9"/></svg>`,
    book: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></svg>`,
    box: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>`,
    lib: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3h4v18H4zM10 3h4v18h-4zM17 4l3 16-3.6.7L14 5z"/></svg>`,
    warn: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>`,
    lock: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
    github: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-.87-.01-1.71-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.4 9.4 0 0 1 5 0c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.35 4.8-4.58 5.05.36.32.68.94.68 1.9 0 1.37-.01 2.480-.01 2.81 0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z"/></svg>`,
    trash: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
    folder: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2Z"/><path d="m12 10 3 3-3 3"/></svg>`,
    arrow: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
  };

  // ── Helpers ──
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
    );
  }
  function fmtBytes(n) {
    if (!n || n <= 0) return "—";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let v = n, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
  }
  function initialsAvatar(name) {
    const initials = name.split(/[\s/-]+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" rx="8" fill="#3a3d41"/><text x="50%" y="54%" font-size="18" fill="#c8c8c8" font-family="sans-serif" text-anchor="middle" dominant-baseline="middle">${initials}</text></svg>`;
    return "data:image/svg+xml;base64," + btoa(svg);
  }
  function md(src) {
    if (!src) return "";
    const lines = src.replace(/\r\n/g, "\n").split("\n");
    let html = "", inCode = false, inList = false;
    const inline = (t) =>
      esc(t)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    for (const line of lines) {
      if (line.trim().startsWith("```")) {
        if (inCode) { html += "</code></pre>"; inCode = false; }
        else { if (inList) { html += "</ul>"; inList = false; } html += "<pre><code>"; inCode = true; }
        continue;
      }
      if (inCode) { html += esc(line) + "\n"; continue; }
      const h = line.match(/^(#{1,3})\s+(.*)/);
      if (h) { if (inList) { html += "</ul>"; inList = false; } html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; continue; }
      if (/^\s*[-*]\s+/.test(line)) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`; continue; }
      if (inList) { html += "</ul>"; inList = false; }
      if (/^\s*>\s?/.test(line)) { html += `<blockquote>${inline(line.replace(/^\s*>\s?/, ""))}</blockquote>`; continue; }
      if (line.trim() === "") continue;
      html += `<p>${inline(line)}</p>`;
    }
    if (inList) html += "</ul>";
    if (inCode) html += "</code></pre>";
    return html;
  }

  // ── Render dispatch ──
  function render() {
    if (state.view === "product") renderProduct();
    else renderList();
  }

  // ── List / wall ──
  function renderList() {
    if (!state.authKnown) {
      app.innerHTML = shell(`<div class="empty"><span class="spin">${I.refresh}</span> Connecting…</div>`);
      return;
    }
    if (!state.signedIn && !state.browsing) return renderWall();

    const allTags = [...new Set(state.listings.flatMap((m) => m.labels))].sort();
    const grid = gridHtml();
    app.innerHTML = `
      <header>
        <span class="brand-kicker">DCS&nbsp;Studio</span>
        <span class="brand-title">Marketplace</span>
        <span class="spacer"></span>
        <span class="who mono">${state.signedIn ? esc(state.login || "signed in") : "browsing as guest"}</span>
      </header>
      <div class="toolbar">
        <div class="search">
          <span class="glass">${I.search}</span>
          <input id="q" placeholder="Search mods…" spellcheck="false" autocomplete="off" value="${esc(state.query)}" />
        </div>
        <select id="tag" aria-label="Filter by tag">
          <option value="">All tags</option>
          ${allTags.map((t) => `<option value="${esc(t)}" ${t === state.activeTag ? "selected" : ""}>${esc(t)}</option>`).join("")}
        </select>
        <select id="sort" aria-label="Sort">
          <option value="stars" ${state.sort === "stars" ? "selected" : ""}>Most stars</option>
          <option value="name" ${state.sort === "name" ? "selected" : ""}>Name</option>
        </select>
        <button class="btn secondary" id="refresh" ${state.listBusy ? "disabled" : ""}>${state.listBusy ? `<span class="spin">${I.refresh}</span>` : I.refresh} Refresh</button>
      </div>
      ${state.listError ? `<div class="market-error">${I.warn} ${esc(state.listError)}</div>` : ""}
      <div id="gridwrap">${grid}</div>
    `;
    document.getElementById("q").addEventListener("input", (e) => {
      state.query = e.target.value;
      document.getElementById("gridwrap").innerHTML = gridHtml();
      bindCards();
    });
    document.getElementById("tag").addEventListener("change", (e) => { state.activeTag = e.target.value; renderList(); });
    document.getElementById("sort").addEventListener("change", (e) => { state.sort = e.target.value; renderList(); });
    document.getElementById("refresh").addEventListener("click", () => post({ type: "discover", force: true }));
    bindCards();
  }

  function shell(inner) {
    return `<header><span class="brand-kicker">DCS&nbsp;Studio</span><span class="brand-title">Marketplace</span></header>${inner}`;
  }

  function renderWall() {
    app.innerHTML = `
      <header><span class="brand-kicker">DCS&nbsp;Studio</span><span class="brand-title">Marketplace</span></header>
      <div class="wall">
        <div class="wall-lock">${I.lock}</div>
        <h2>Sign in to browse the Marketplace</h2>
        <p>Discovery searches GitHub for public repositories tagged <span class="mono">${esc(state.topic)}</span>. Signing in raises the rate limit and lets you install into your DCS folders.</p>
        <button class="btn" id="signin">${I.github} Sign in with GitHub</button>
        <button class="link" id="anon">Browse without signing in</button>
      </div>`;
    document.getElementById("signin").addEventListener("click", () => post({ type: "signIn" }));
    document.getElementById("anon").addEventListener("click", () => post({ type: "browseAnon" }));
  }

  function filtered() {
    const q = state.query.trim().toLowerCase();
    return state.listings
      .filter((m) => {
        if (state.activeTag && !m.labels.includes(state.activeTag)) return false;
        if (!q) return true;
        return (
          m.name.toLowerCase().includes(q) ||
          m.author.toLowerCase().includes(q) ||
          m.description.toLowerCase().includes(q) ||
          m.labels.some((l) => l.toLowerCase().includes(q))
        );
      })
      .sort((a, b) => (state.sort === "stars" ? b.stars - a.stars : a.name.localeCompare(b.name)));
  }

  function gridHtml() {
    if (state.listBusy && state.listings.length === 0)
      return `<div class="empty"><span class="spin">${I.refresh}</span> Searching GitHub…</div>`;
    const xs = filtered();
    if (xs.length === 0) {
      if (state.listings.length === 0)
        return `<div class="empty">No public repos are tagged <span class="mono">${esc(state.topic)}</span> yet. Publish one by adding the <span class="mono">${esc(state.topic)}</span> topic to a GitHub repo.</div>`;
      return `<div class="empty">No mods match your search.</div>`;
    }
    return `<div class="grid">${xs.map(card).join("")}</div>`;
  }

  function card(m) {
    return `
      <div class="card">
        <button class="card-head" data-open="${esc(m.repo)}">
          <img class="avatar" src="${esc(m.avatar_url)}" alt="" data-fallback="${esc(m.name)}" />
          <span style="min-width:0;flex:1">
            <span class="card-title-row">
              <span class="card-title">${esc(m.name)}</span>
              ${m.is_library ? `<span class="badge">library</span>` : ""}
            </span>
            <span class="card-author">by ${esc(m.author)}</span>
          </span>
          <span class="stars">${I.star}${m.stars}</span>
        </button>
        ${m.description ? `<div class="blurb">${esc(m.description)}</div>` : ""}
        ${m.labels.length ? `<div class="tags">${m.labels.slice(0, 6).map((l) => `<button class="tag" data-tag="${esc(l)}">${I.tag}${esc(l)}</button>`).join("")}</div>` : ""}
        <div class="card-foot">
          <button class="link" data-open="${esc(m.repo)}">Details</button>
          <button class="link muted" data-github="${esc(m.repo_url)}">GitHub ${I.ext}</button>
        </div>
      </div>`;
  }

  function bindCards() {
    document.querySelectorAll("img[data-fallback]").forEach((img) =>
      img.addEventListener("error", () => (img.src = initialsAvatar(img.getAttribute("data-fallback")))),
    );
    document.querySelectorAll("[data-open]").forEach((el) =>
      el.addEventListener("click", () => openProduct(el.getAttribute("data-open"))),
    );
    document.querySelectorAll("[data-tag]").forEach((el) =>
      el.addEventListener("click", (e) => { e.stopPropagation(); state.activeTag = el.getAttribute("data-tag"); renderList(); }),
    );
    document.querySelectorAll("[data-github]").forEach((el) =>
      el.addEventListener("click", (e) => { e.stopPropagation(); post({ type: "openExternal", url: el.getAttribute("data-github") }); }),
    );
  }

  // ── Product ──
  function openProduct(repo) {
    state.view = "product";
    state.repo = repo;
    state.product = null;
    state.productBusy = true;
    state.productError = null;
    save();
    post({ type: "openProduct", repo });
    renderProduct();
  }

  function renderProduct() {
    if (state.productBusy) {
      app.innerHTML = productShell(`<div class="empty"><span class="spin">${I.refresh}</span> Loading ${esc(state.repo || "")}…</div>`);
      wireBack();
      return;
    }
    if (state.productError) {
      app.innerHTML = productShell(`<div class="empty"><p class="market-error" style="border:none;background:none">${I.warn} ${esc(state.productError)}</p><button class="btn secondary" id="retry">Try again</button></div>`);
      wireBack();
      const r = document.getElementById("retry");
      if (r) r.addEventListener("click", () => openProduct(state.repo));
      return;
    }
    const p = state.product;
    if (!p) { state.view = "list"; return renderList(); }

    let action = "";
    if (p.is_library) {
      action = `<div class="installed-row">${I.lib} Library</div>
        <p class="note">A dependency-only library — used by other mods, not installed into DCS directly.</p>`;
    } else if (!p.installable) {
      action = `<p class="note warn">${I.warn} Not installable — the latest release ships no <span class="mono">dcs-studio.toml</span>${p.release_tag ? "" : " (no release yet)"}.</p>`;
    } else if (state.installed) {
      action = `<div class="installed-row">${I.check} Installed</div>
        <button class="btn secondary block" id="uninstall" style="margin-top:10px">${I.trash} Uninstall</button>
        <p class="note">Enable/disable/update it under <b>My Mods</b>.</p>`;
    } else if (state.installing) {
      const pct = Math.round((state.installing.pct || 0) * 100);
      action = `<div class="progress"><div style="font-size:12px;display:flex;gap:6px;align-items:center"><span class="spin">${I.refresh}</span> ${esc(state.installing.label)}</div>
        <div class="bar"><span style="width:${state.installing.phase === "download" ? pct : 100}%"></span></div></div>`;
    } else {
      action = `<button class="btn block" id="install">${I.download} Install</button>
        <p class="note">Downloads &amp; unpacks to your data dir, then links the files into your DCS folders.</p>`;
    }
    if (state.installError) action += `<p class="note warn" style="margin-top:8px">${I.warn} ${esc(state.installError)}</p>`;

    const plan = state.plan;
    const planCard =
      plan && plan.installs && plan.installs.length
        ? `<div class="aside-card"><div class="section-label">${I.folder} Install plan</div>${plan.installs
            .map((r) => `<div class="plan-item"><div>${esc(r.source)}</div><div class="plan-dest">${I.arrow}${esc(r.resolved || r.dest)}</div></div>`)
            .join("")}</div>`
        : "";
    const reqCard =
      plan && plan.requires && plan.requires.length
        ? `<div class="aside-card"><div class="section-label">${I.warn} Requires DCS modules</div>${plan.requires.map((r) => `<div class="kv"><span class="name">${esc(r.id)}</span></div>`).join("")}</div>`
        : "";

    app.innerHTML = `
      <header>
        <button class="icon-btn" id="back" title="Back to Marketplace">${I.back}</button>
        <span class="brand-kicker">Marketplace</span>
        <span class="spacer"></span>
      </header>
      <div class="product">
        <main>
          <div style="display:flex;gap:12px;align-items:flex-start">
            <img class="avatar lg" src="${esc(p.avatar_url)}" alt="" data-fallback="${esc(p.name)}" />
            <div style="min-width:0">
              <h1>${esc(p.name)}</h1>
              <div class="product-meta">
                <span>by ${esc(p.author)}</span>
                <span>${I.star}${p.stars}</span>
                ${p.release_tag ? `<span>${esc(p.release_tag)}</span>` : ""}
              </div>
            </div>
          </div>
          ${p.description ? `<p class="product-desc">${esc(p.description)}</p>` : ""}
          <div class="section-label">${I.book} Readme</div>
          <div class="prose">${p.readme ? md(p.readme) : "<p class='note'>This repo has no README.</p>"}</div>
        </main>
        <aside>
          <div class="aside-card">${action}</div>
          ${planCard}
          ${reqCard}
          <div class="aside-card">
            <div class="section-label">${I.hd} Download</div>
            <div>${fmtBytes(p.download_size)}</div>
            ${p.assets.length
              ? `<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">${p.assets.map((a) => `<div class="kv"><span class="name">${I.box} ${esc(a.name)}</span><span class="mono" style="color:var(--muted)">${fmtBytes(a.size)}</span></div>`).join("")}</div>`
              : `<p class="note">No release assets.</p>`}
          </div>
          <button class="btn secondary block" id="viewgh" style="margin-top:14px">View on GitHub ${I.ext}</button>
        </aside>
      </div>`;

    document.querySelectorAll("img[data-fallback]").forEach((img) =>
      img.addEventListener("error", () => (img.src = initialsAvatar(img.getAttribute("data-fallback")))),
    );
    wireBack();
    document.getElementById("viewgh").addEventListener("click", () => post({ type: "openExternal", url: p.repo_url }));
    const inst = document.getElementById("install");
    if (inst) inst.addEventListener("click", () => { state.installError = null; state.installing = { phase: "download", label: "Starting…", pct: 0 }; renderProduct(); post({ type: "install", repo: p.repo }); });
    const unins = document.getElementById("uninstall");
    if (unins) unins.addEventListener("click", () => post({ type: "uninstall", repo: p.repo }));
  }

  function productShell(inner) {
    return `<header><button class="icon-btn" id="back" title="Back to Marketplace">${I.back}</button><span class="brand-kicker">Marketplace</span></header>${inner}`;
  }
  function wireBack() {
    const b = document.getElementById("back");
    if (b) b.addEventListener("click", () => { state.view = "list"; state.repo = null; save(); renderList(); });
  }

  // ── Host messages ──
  window.addEventListener("message", (e) => {
    const m = e.data;
    switch (m.type) {
      case "auth":
        state.authKnown = true;
        state.signedIn = m.signedIn;
        state.browsing = m.browsing;
        state.login = m.login || null;
        state.topic = m.topic || state.topic;
        if (state.view === "list") renderList();
        break;
      case "listings:busy":
        state.listBusy = true;
        state.listError = null;
        if (state.view === "list") renderList();
        break;
      case "listings":
        state.listBusy = false;
        state.listings = m.listings || [];
        state.listError = null;
        if (state.view === "list") renderList();
        break;
      case "listings:error":
        state.listBusy = false;
        state.listError = m.message;
        if (state.view === "list") renderList();
        break;
      case "product:busy":
        if (state.repo === m.repo) { state.productBusy = true; state.productError = null; if (state.view === "product") renderProduct(); }
        break;
      case "product":
        state.productBusy = false;
        state.product = m.product;
        state.repo = m.product.repo;
        state.plan = m.plan || null;
        state.installed = !!m.installed;
        state.installing = null;
        state.installError = null;
        if (state.view === "product") renderProduct();
        break;
      case "product:error":
        if (state.repo === m.repo) { state.productBusy = false; state.productError = m.message; if (state.view === "product") renderProduct(); }
        break;
      case "installProgress":
        if (state.product && state.product.repo === m.repo) { state.installing = { phase: m.phase, label: m.label, pct: m.pct }; if (state.view === "product") renderProduct(); }
        break;
      case "installed":
        if (state.product && state.product.repo === m.repo) { state.installing = null; state.installed = true; state.installError = null; if (state.view === "product") renderProduct(); }
        break;
      case "uninstalled":
        if (state.product && state.product.repo === m.repo) { state.installed = false; if (state.view === "product") renderProduct(); }
        break;
      case "installError":
        if (state.product && state.product.repo === m.repo) { state.installing = null; state.installError = m.message; if (state.view === "product") renderProduct(); }
        break;
    }
  });

  // ── Boot ──
  render();
  post({ type: "ready" });
  if (state.view === "product" && state.repo) openProduct(state.repo);
})();
