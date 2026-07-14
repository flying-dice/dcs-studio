// @ts-nocheck
// Documentation panel renderer. Content (sections/pages) is defined in
// docs-content.js as window.__DOCS__; this file renders the TOC + active page
// and handles internal page links, external links, and command buttons.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const DOCS = window.__DOCS__ || { sections: [] };
  const pages = DOCS.sections.flatMap((s) => s.pages);

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  const state = vscode.getState() || {};
  let current =
    window.__INITIAL_PAGE__ && pages.some((p) => p.id === window.__INITIAL_PAGE__)
      ? window.__INITIAL_PAGE__
      : pages.some((p) => p.id === state.page)
        ? state.page
        : pages[0] && pages[0].id;

  app.innerHTML = `
    <div class="toc" data-testid="toc">
      <div class="kicker">DCS&nbsp;Studio&nbsp;Docs</div>
      ${DOCS.sections
        .map(
          (s) => `
        <div class="group">
          <div class="kicker">${esc(s.title)}</div>
          ${s.pages.map((p) => `<a class="page" data-testid="toc-link" data-page="${p.id}">${esc(p.title)}</a>`).join("")}
        </div>`,
        )
        .join("")}
    </div>
    <div class="content"><div class="page-inner" id="page"></div></div>
  `;

  const pageEl = document.getElementById("page");
  const contentEl = app.querySelector(".content");

  function pagerHtml(id) {
    const i = pages.findIndex((p) => p.id === id);
    const prev = pages[i - 1];
    const next = pages[i + 1];
    if (!prev && !next) return "";
    return `<div class="pager">
      ${prev ? `<a data-testid="pager-prev" data-page="${prev.id}"><span class="dir">Previous</span><span class="name">${esc(prev.title)}</span></a>` : ""}
      ${next ? `<a class="next" data-testid="pager-next" data-page="${next.id}"><span class="dir">Next</span><span class="name">${esc(next.title)}</span></a>` : ""}
    </div>`;
  }

  function render(id) {
    const page = pages.find((p) => p.id === id) || pages[0];
    if (!page) return;
    current = page.id;
    vscode.setState({ page: current });
    app.querySelectorAll(".toc a.page").forEach((el) => {
      el.classList.toggle("active", el.dataset.page === current);
    });
    const section = DOCS.sections.find((s) => s.pages.includes(page));
    pageEl.innerHTML = `
      <div class="kicker">${esc(section ? section.title : "")}</div>
      <h1 data-testid="page-title">${esc(page.title)}</h1>
      ${page.lede ? `<p class="lede">${page.lede}</p>` : ""}
      <div data-testid="page-body">${page.body}</div>
      ${pagerHtml(current)}
    `;
    // The page body's "try it" buttons are content (docs-content.js), not
    // markup owned by this file — tag them here rather than in every page.
    pageEl.querySelectorAll(".cmd-btn").forEach((btn) => btn.setAttribute("data-testid", "command-btn"));
    contentEl.scrollTop = 0;
  }

  // One delegated click handler: internal page links, external links, command buttons.
  app.addEventListener("click", (e) => {
    const pageLink = e.target.closest("[data-page]");
    if (pageLink) {
      e.preventDefault();
      render(pageLink.dataset.page);
      return;
    }
    const cmdBtn = e.target.closest("[data-command]");
    if (cmdBtn) {
      vscode.postMessage({ type: "run", command: cmdBtn.dataset.command });
      return;
    }
    const link = e.target.closest("a[href]");
    if (link && /^https?:/.test(link.getAttribute("href"))) {
      e.preventDefault();
      vscode.postMessage({ type: "openExternal", url: link.getAttribute("href") });
    }
  });

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m && m.type === "goto" && m.page) render(m.page);
  });

  render(current);
})();
