// @ts-nocheck
// Storefront SPA. The webview owns view state (grid, product page, search/tag/
// sort); the extension host owns GitHub (auth, topic discovery, product loads)
// and answers messages. Sign-in gated with a browse-without-signing-in fallback,
// mirroring dcs-studio's /marketplace.
(() => {
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
    manifest: null, // derived install-manifest view-model (host-supplied)
    requires: [], // required DCS modules (separate card)
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

  const { esc, formatBytes, formatRecency, initialsAvatar, renderMarkdown, iconPaths } = dcsUi;

  // ── Icons ──
  const I = {
    search: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`,
    star: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15 9 22 9.3 16.5 14 18.5 21 12 17 5.5 21 7.5 14 2 9.3 9 9"/></svg>`,
    tag: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.6 2.6 21 11a2 2 0 0 1 0 2.8l-6.2 6.2a2 2 0 0 1-2.8 0L3.6 11.6A2 2 0 0 1 3 10.2V4a1 1 0 0 1 1-1h6.2a2 2 0 0 1 1.4.6Z"/><circle cx="7.5" cy="7.5" r="1"/></svg>`,
    back: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>`,
    refresh: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconPaths.refresh}</svg>`,
    ext: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`,
    download: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconPaths.download}</svg>`,
    check: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
    hd: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 18h.01M10 18h.01"/><path d="m6 14 3-9h6l3 9"/></svg>`,
    book: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/></svg>`,
    box: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>`,
    warn: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>`,
    lock: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
    github: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="currentColor">${iconPaths.github}</svg>`,
    trash: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
    folder: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2Z"/><path d="m12 10 3 3-3 3"/></svg>`,
    arrow: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
    link: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5"/></svg>`,
    terminal: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>`,
    script: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/></svg>`,
    clock: `<svg class="codicon-inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  };

  // ── Install-manifest transparency (issue #12) — the badge strip + the script-
  // execution notice are the shared dcsUi renderers (parameterised by the
  // per-surface class names / test-ids / icons and the notice body copy). The
  // section builders below stay local: their DOM differs from My Mods'. ──

  // The compact risk badges shown before the Install action.
  function riskBadgesHtml(manifest) {
    return dcsUi.riskBadges(manifest, {
      wrapClass: "risk-summary",
      wrapTestid: "risk-summary",
      badgeClass: "risk-badge",
      badgeTestid: "risk-badge",
      warnIcon: I.warn,
      okIcon: I.check,
    });
  }

  // The leading "Script Execution Notice" alert — shown whenever a mod ships any
  // before-sanitize mission script. Copy adapted from DCS Dropzone; "Learn more"
  // routes the host to the sandbox explainer in the Docs panel.
  function sanitizeNoticeHtml(count) {
    const n = count === 1 ? "1 script that runs" : `${count} scripts that run`;
    return dcsUi.sanitizeNotice({
      wrapClass: "alert warn",
      wrapTestid: "sanitize-notice",
      headClass: "alert-head",
      icon: I.warn,
      body: `<p>This mod includes ${n} <strong>before</strong> DCS World's scripting sandbox is applied. These scripts may have broader access than standard sandboxed scripts — full <span class="mono">os</span>/<span class="mono">io</span>/<span class="mono">lfs</span>/<span class="mono">require</span> (file and OS) access. Please ensure you trust the source before installing.</p>`,
      linkClass: "link",
      learnTestid: "sanitize-learn-more",
    });
  }

  function bundleSectionHtml(manifest) {
    const items = manifest.bundles.length
      ? manifest.bundles
          .map(
            (b) => `<div class="plan-item" data-testid="bundle-item">${I.box} ${esc(b.path)}</div>`,
          )
          .join("")
      : `<p class="note">This mod bundles no content (manifest-only).</p>`;
    return `<div class="manifest-section" data-testid="section-bundles">
      <div class="section-label">${I.box} Bundled content <span class="count-badge">${manifest.counts.bundles}</span></div>
      ${items}</div>`;
  }

  function symlinkSectionHtml(manifest) {
    const items = manifest.symlinks.length
      ? manifest.symlinks
          .map(
            (s) =>
              `<div class="plan-item" data-testid="symlink-item"><div>${esc(s.source)}</div><div class="plan-dest">${I.arrow}${esc(
                s.resolved || s.dest,
              )}</div></div>`,
          )
          .join("")
      : `<p class="note">This mod links no files into your DCS folders.</p>`;
    return `<div class="manifest-section" data-testid="section-symlinks">
      <div class="section-label">${I.link} Symlinks <span class="count-badge">${manifest.counts.symlinks}</span></div>
      ${items}</div>`;
  }

  function executableSectionHtml(manifest) {
    if (!manifest.entrypoints.length) return "";
    const items = manifest.entrypoints
      .map(
        (e) =>
          `<div class="plan-item warn-item" data-testid="executable-item"><div>${I.terminal} <strong>${esc(
            e.name,
          )}</strong></div><div class="plan-dest mono">${esc(e.exe)}${
            e.args?.length ? ` ${esc(e.args.join(" "))}` : ""
          }</div></div>`,
      )
      .join("");
    return `<div class="manifest-section warn-section" data-testid="section-executables">
      <div class="section-label warn">${I.warn} Executables <span class="count-badge warn">${manifest.counts.entrypoints}</span></div>
      <p class="note warn">This mod can launch executable programs on your machine. Only launch executables from sources you trust.</p>
      ${items}</div>`;
  }

  function missionScriptSectionHtml(manifest) {
    if (!manifest.missionScripts.length) return "";
    const before = manifest.counts.beforeSanitize;
    const notice = before > 0 ? sanitizeNoticeHtml(before) : "";
    const items = manifest.missionScripts
      .map((s) => {
        const b = s.beforeSanitize;
        return `<div class="plan-item${b ? " warn-item" : ""}" data-testid="mission-script-item" data-run="${esc(s.run_on)}">
          <div>${I.script} <strong>${esc(s.name)}</strong>${
            b
              ? ` <span class="badge warn" data-testid="before-sanitize-tag">before-sanitize</span>`
              : ""
          }</div>
          ${s.purpose ? `<div class="plan-dest">${esc(s.purpose)}</div>` : ""}
          <div class="plan-dest mono">${esc(s.path)}</div>
        </div>`;
      })
      .join("");
    const badge =
      before > 0
        ? ` <span class="count-badge warn" data-testid="before-sanitize-badge">${before} before-sanitize</span>`
        : "";
    return `<div class="manifest-section${before > 0 ? " warn-section" : ""}" data-testid="section-mission-scripts">
      <div class="section-label${before > 0 ? " warn" : ""}">${I.script} Mission scripts <span class="count-badge">${
        manifest.counts.missionScripts
      }</span>${badge}</div>
      ${notice}
      ${items}</div>`;
  }

  // The whole install-manifest block for the product main column. Never a silent
  // gap: an unreadable manifest renders the explicit unknown state; otherwise the
  // full enumeration (bundled content, symlinks, executables, mission scripts).
  function installManifestHtml(manifest, installable) {
    if (!installable) return ""; // not-installable note already shown by the action card
    if (!manifest?.known) {
      return `<div class="alert warn" data-testid="manifest-unknown">
        <div class="alert-head">${I.warn} Install actions unknown</div>
        <p>This release's manifest could not be read, so DCS Studio can't show what installing this mod would do. Proceed only if you trust the source.</p>
      </div>`;
    }
    return `<div class="install-manifest" data-testid="install-manifest">
      ${bundleSectionHtml(manifest)}
      ${symlinkSectionHtml(manifest)}
      ${executableSectionHtml(manifest)}
      ${missionScriptSectionHtml(manifest)}
    </div>`;
  }

  // ── Render dispatch ──
  function render() {
    if (state.view === "product") renderProduct();
    else renderList();
  }

  // ── List / wall ──
  function renderList() {
    if (!state.authKnown) {
      app.innerHTML = shell(
        `<div class="empty"><span class="spin">${I.refresh}</span> Connecting…</div>`,
      );
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
          <input id="q" data-testid="search-input" placeholder="Search mods…" spellcheck="false" autocomplete="off" value="${esc(state.query)}" />
        </div>
        <select id="tag" data-testid="tag-select" aria-label="Filter by tag">
          <option value="">All tags</option>
          ${allTags.map((t) => `<option value="${esc(t)}" ${t === state.activeTag ? "selected" : ""}>${esc(t)}</option>`).join("")}
        </select>
        <select id="sort" data-testid="sort-select" aria-label="Sort">
          <option value="stars" ${state.sort === "stars" ? "selected" : ""}>Most stars</option>
          <option value="name" ${state.sort === "name" ? "selected" : ""}>Name</option>
        </select>
        <button class="btn secondary" id="refresh" ${state.listBusy ? "disabled" : ""}>${state.listBusy ? `<span class="spin">${I.refresh}</span>` : I.refresh} Refresh</button>
      </div>
      ${state.listError ? `<div class="market-error" data-testid="list-error">${I.warn} ${esc(state.listError)}</div>` : ""}
      <div id="gridwrap">${grid}</div>
    `;
    document.getElementById("q").addEventListener("input", (e) => {
      state.query = e.target.value;
      document.getElementById("gridwrap").innerHTML = gridHtml();
      bindCards();
    });
    document.getElementById("tag").addEventListener("change", (e) => {
      state.activeTag = e.target.value;
      renderList();
    });
    document.getElementById("sort").addEventListener("change", (e) => {
      state.sort = e.target.value;
      renderList();
    });
    document
      .getElementById("refresh")
      .addEventListener("click", () => post({ type: "discover", force: true }));
    bindCards();
  }

  function shell(inner) {
    return `<header><span class="brand-kicker">DCS&nbsp;Studio</span><span class="brand-title">Marketplace</span></header>${inner}`;
  }

  function renderWall() {
    app.innerHTML = `
      <header><span class="brand-kicker">DCS&nbsp;Studio</span><span class="brand-title">Marketplace</span></header>
      <div class="wall" data-testid="signin-wall">
        <div class="wall-lock">${I.lock}</div>
        <h2>Sign in to browse the Marketplace</h2>
        <p>Discovery searches GitHub for public repositories tagged <span class="mono">${esc(state.topic)}</span>. Signing in raises the rate limit and lets you install into your DCS folders.</p>
        <button class="btn" id="signin" data-testid="signin-btn">${I.github} Sign in with GitHub</button>
        <button class="link" id="anon" data-testid="browse-anon-btn">Browse without signing in</button>
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
      return `<div class="empty" data-testid="list-loading"><span class="spin">${I.refresh}</span> Searching GitHub…</div>`;
    const xs = filtered();
    if (xs.length === 0) {
      if (state.listings.length === 0)
        return `<div class="empty" data-testid="list-empty">No public repos are tagged <span class="mono">${esc(state.topic)}</span> yet. Publish one by adding the <span class="mono">${esc(state.topic)}</span> topic to a GitHub repo.</div>`;
      return `<div class="empty" data-testid="list-empty">No mods match your search.</div>`;
    }
    return `<div class="grid">${xs.map(card).join("")}</div>`;
  }

  function card(m) {
    return `
      <div class="card" data-testid="mod-card" data-repo="${esc(m.repo)}">
        <button class="card-head" data-open="${esc(m.repo)}">
          <img class="avatar" src="${esc(m.avatar_url)}" alt="" data-fallback="${esc(m.name)}" />
          <span style="min-width:0;flex:1">
            <span class="card-title-row">
              <span class="card-title" data-testid="card-title">${esc(m.name)}</span>
            </span>
            <span class="card-author">by ${esc(m.author)}</span>
          </span>
          <span class="stars">${I.star}${m.stars}</span>
        </button>
        ${m.description ? `<div class="blurb">${esc(m.description)}</div>` : ""}
        ${
          m.labels.length
            ? `<div class="tags">${m.labels
                .slice(0, 6)
                .map((l) => `<button class="tag" data-tag="${esc(l)}">${I.tag}${esc(l)}</button>`)
                .join("")}</div>`
            : ""
        }
        <div class="card-foot">
          <button class="link" data-open="${esc(m.repo)}">Details</button>
          <button class="link muted" data-github="${esc(m.repo_url)}">GitHub ${I.ext}</button>
        </div>
      </div>`;
  }

  function bindCards() {
    document.querySelectorAll("img[data-fallback]").forEach((img) => {
      img.addEventListener(
        "error",
        () => (img.src = initialsAvatar(img.getAttribute("data-fallback"))),
      );
    });
    document.querySelectorAll("[data-open]").forEach((el) => {
      el.addEventListener("click", () => openProduct(el.getAttribute("data-open")));
    });
    document.querySelectorAll("[data-tag]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        state.activeTag = el.getAttribute("data-tag");
        renderList();
      });
    });
    document.querySelectorAll("[data-github]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        post({ type: "openExternal", url: el.getAttribute("data-github") });
      });
    });
  }

  // ── Product ──
  function openProduct(repo) {
    state.view = "product";
    state.repo = repo;
    state.product = null;
    state.manifest = null;
    state.requires = [];
    state.productBusy = true;
    state.productError = null;
    save();
    post({ type: "openProduct", repo });
    renderProduct();
  }

  function renderProduct() {
    if (state.productBusy) {
      app.innerHTML = productShell(
        `<div class="empty"><span class="spin">${I.refresh}</span> Loading ${esc(state.repo || "")}…</div>`,
      );
      wireBack();
      return;
    }
    if (state.productError) {
      app.innerHTML = productShell(
        `<div class="empty"><p class="market-error" style="border:none;background:none">${I.warn} ${esc(state.productError)}</p><button class="btn secondary" id="retry">Try again</button></div>`,
      );
      wireBack();
      const r = document.getElementById("retry");
      if (r) r.addEventListener("click", () => openProduct(state.repo));
      return;
    }
    const p = state.product;
    if (!p) {
      state.view = "list";
      return renderList();
    }

    let action = "";
    if (!p.installable) {
      action = `<p class="note warn">${I.warn} Not installable — the latest release ships no <span class="mono">dcs-studio.toml</span>${p.release_tag ? "" : " (no release yet)"}.</p>`;
    } else if (state.installed) {
      action = `<div class="installed-row" data-testid="installed-row">${I.check} Installed</div>
        <button class="btn secondary block" id="uninstall" data-testid="uninstall-btn" style="margin-top:10px">${I.trash} Uninstall</button>
        <p class="note">Enable/disable/update it under <b>My Mods</b>.</p>`;
    } else if (state.installing) {
      const pct = Math.round((state.installing.pct || 0) * 100);
      action = `<div class="progress" data-testid="install-progress"><div style="font-size:12px;display:flex;gap:6px;align-items:center"><span class="spin">${I.refresh}</span> ${esc(state.installing.label)}</div>
        <div class="bar"><span style="width:${state.installing.phase === "download" ? pct : 100}%"></span></div></div>`;
    } else {
      action = `<button class="btn block" id="install" data-testid="install-btn">${I.download} Install</button>
        <p class="note">Downloads &amp; unpacks to your data dir, then links the files into your DCS folders.</p>`;
    }
    if (state.installError)
      action += `<p class="note warn" data-testid="install-error" style="margin-top:8px">${I.warn} ${esc(state.installError)}</p>`;

    const reqCard = state.requires?.length
      ? `<div class="aside-card" data-testid="requires-card"><div class="section-label">${I.warn} Requires DCS modules</div>${state.requires.map((r) => `<div class="kv"><span class="name">${esc(r.id)}</span></div>`).join("")}</div>`
      : "";
    const recency = formatRecency(p.release_date);

    app.innerHTML = `
      <header>
        <button class="icon-btn" id="back" data-testid="back-btn" title="Back to Marketplace">${I.back}</button>
        <span class="brand-kicker">Marketplace</span>
        <span class="spacer"></span>
      </header>
      <div class="product">
        <main>
          <div style="display:flex;gap:12px;align-items:flex-start">
            <img class="avatar lg" src="${esc(p.avatar_url)}" alt="" data-fallback="${esc(p.name)}" />
            <div style="min-width:0">
              <h1 data-testid="product-title">${esc(p.name)}</h1>
              <div class="product-meta">
                <span>by ${esc(p.author)}</span>
                <span>${I.star}${p.stars}</span>
                ${p.release_tag ? `<span>${esc(p.release_tag)}</span>` : ""}
                ${recency ? `<span data-testid="release-recency">${I.clock}${esc(recency)}</span>` : ""}
              </div>
            </div>
          </div>
          ${riskBadgesHtml(state.manifest)}
          ${p.description ? `<p class="product-desc">${esc(p.description)}</p>` : ""}
          ${installManifestHtml(state.manifest, p.installable)}
          <div class="section-label">${I.book} Readme</div>
          <div class="prose" data-testid="readme">${p.readme ? renderMarkdown(p.readme) : "<p class='note'>This repo has no README.</p>"}</div>
        </main>
        <aside>
          <div class="aside-card">${action}</div>
          ${reqCard}
          <div class="aside-card">
            <div class="section-label">${I.hd} Download</div>
            <div>${formatBytes(p.download_size)}</div>
            ${
              p.assets.length
                ? `<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">${p.assets.map((a) => `<div class="kv"><span class="name">${I.box} ${esc(a.name)}</span><span class="mono" style="color:var(--muted)">${formatBytes(a.size)}</span></div>`).join("")}</div>`
                : `<p class="note">No release assets.</p>`
            }
          </div>
          <button class="btn secondary block" id="viewgh" style="margin-top:14px">View on GitHub ${I.ext}</button>
        </aside>
      </div>`;

    document.querySelectorAll("img[data-fallback]").forEach((img) => {
      img.addEventListener(
        "error",
        () => (img.src = initialsAvatar(img.getAttribute("data-fallback"))),
      );
    });
    wireBack();
    document
      .getElementById("viewgh")
      .addEventListener("click", () => post({ type: "openExternal", url: p.repo_url }));
    const inst = document.getElementById("install");
    if (inst)
      inst.addEventListener("click", () => {
        state.installError = null;
        state.installing = { phase: "download", label: "Starting…", pct: 0 };
        renderProduct();
        post({ type: "install", repo: p.repo });
      });
    const unins = document.getElementById("uninstall");
    if (unins) unins.addEventListener("click", () => post({ type: "uninstall", repo: p.repo }));
    document.querySelectorAll("[data-docs]").forEach((el) => {
      el.addEventListener("click", () =>
        post({ type: "openDocs", page: el.getAttribute("data-docs") }),
      );
    });
  }

  function productShell(inner) {
    return `<header><button class="icon-btn" id="back" data-testid="back-btn" title="Back to Marketplace">${I.back}</button><span class="brand-kicker">Marketplace</span></header>${inner}`;
  }
  function wireBack() {
    const b = document.getElementById("back");
    if (b)
      b.addEventListener("click", () => {
        state.view = "list";
        state.repo = null;
        save();
        renderList();
      });
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
        if (state.repo === m.repo) {
          state.productBusy = true;
          state.productError = null;
          if (state.view === "product") renderProduct();
        }
        break;
      case "product":
        state.productBusy = false;
        state.product = m.product;
        state.repo = m.product.repo;
        state.manifest = m.manifest || null;
        state.requires = m.requires || [];
        state.installed = !!m.installed;
        state.installing = null;
        state.installError = null;
        if (state.view === "product") renderProduct();
        break;
      case "product:error":
        if (state.repo === m.repo) {
          state.productBusy = false;
          state.productError = m.message;
          if (state.view === "product") renderProduct();
        }
        break;
      case "installProgress":
        if (state.product && state.product.repo === m.repo) {
          state.installing = { phase: m.phase, label: m.label, pct: m.pct };
          if (state.view === "product") renderProduct();
        }
        break;
      case "installed":
        if (state.product && state.product.repo === m.repo) {
          state.installing = null;
          state.installed = true;
          state.installError = null;
          if (state.view === "product") renderProduct();
        }
        break;
      case "uninstalled":
        if (state.product && state.product.repo === m.repo) {
          state.installed = false;
          if (state.view === "product") renderProduct();
        }
        break;
      case "installError":
        if (state.product && state.product.repo === m.repo) {
          state.installing = null;
          state.installError = m.message;
          if (state.view === "product") renderProduct();
        }
        break;
    }
  });

  // ── Boot ──
  render();
  post({ type: "ready" });
  if (state.view === "product" && state.repo) openProduct(state.repo);
})();
