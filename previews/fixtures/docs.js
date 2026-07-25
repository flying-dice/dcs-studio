// Fixture for previews/docs.html. Loads AFTER media/docs-content.js and
// BEFORE media/docs.js, which is the only window in which window.__DOCS__ and
// window.__INITIAL_PAGE__ can still be changed — docs.js snapshots both at the
// top of its IIFE.
//
// By default it leaves the real shipped content alone, so the preview is the
// actual docs. `?docs=` swaps in a small hand-built set for the shapes the
// real content happens not to have:
//   single    one page, so there is no pager at all
//   empty     no __DOCS__ at all — what a missing/failed content script leaves
//   orphan    a doc set whose sections do not own the pages they list, i.e.
//             content the renderer must survive rather than throw on
// `?page=<id>` sets __INITIAL_PAGE__ the way the host does when a command deep
// links into a specific doc page.
(function () {
  const params = new URLSearchParams(location.search);
  window.__INITIAL_PAGE__ = params.get("page") || "";

  const which = params.get("docs") || "";

  if (which === "empty") {
    window.__DOCS__ = undefined;
    return;
  }

  if (which === "single") {
    window.__DOCS__ = {
      sections: [
        {
          title: "Only Section",
          pages: [{ id: "only", title: "Only Page", body: "<p>The whole manual.</p>" }],
        },
      ],
    };
    return;
  }

  if (which === "orphan") {
    // A content script that computes its sections per access rather than
    // holding one array: every read mints fresh page objects, so the flat page
    // list docs.js snapshots at load is never found in a section afterwards.
    // That is exactly the malformed shape the renderer's section lookup guards
    // against — it must still draw the page, just without a section kicker.
    window.__DOCS__ = {
      get sections() {
        return [
          {
            title: "Section",
            pages: [
              { id: "a", title: "Page A", lede: "With a lede.", body: "<p>a</p>" },
              { id: "b", title: "Page B", body: "<p>b</p>" },
            ],
          },
        ];
      },
    };
  }
})();
