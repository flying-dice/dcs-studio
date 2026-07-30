---
column: backlog
labels: [bug, webview]
priority: low
live: false
updatedAt: 2026-07-31T05:00:00.000Z
---
# A docs deep link to a page that does not exist loses the reader's place

Found while giving the docs panel a presenter (card 14's `docs` item). The two
halves of the deep-link rule disagree about what an UNKNOWN page id means, so
the same command has two different outcomes depending on whether the panel
happened to be open already.

`dcs.docs.open(page)` reaches the webview two ways:

- **panel not open** — the page crosses inside the document as
  `window.__INITIAL_PAGE__`, and `media/docs.js:14-19` validates it: an id that
  is not in `pages` is ignored, and the reader gets their persisted page
  (`vscode.getState().page`) or Overview.
- **panel already open** — the page crosses as the `goto` message
  (`src/core/app/docsPresenter.ts:84-87`), and `media/docs.js:97` passes it
  straight to `render`, whose `pages.find(...) || pages[0]` fallback
  (`media/docs.js:52`) silently navigates to **Overview**.

So a Learn-more button whose `data-docs` names a page that has since been
renamed does nothing visible on a closed panel and throws an open reader back to
the front of the manual mid-read. Nothing warns, and the persisted page is
overwritten with Overview on the way (`media/docs.js:55`), so re-opening the
panel does not recover it.

The fix belongs in `media/docs.js`, which is the half that is wrong: `goto`
should ignore an id it does not have, exactly as the boot path does. The host
cannot make this decision — the page ids live in `media/docs-content.js`, which
only the webview loads.

Preserved verbatim by card 14: `DocsPresenter.navigate` reproduces the old
`if (page)` rule unchanged, and `test/unit/docs/docsPresenter.test.ts` pins it.

## Comments

- **opus-docs** (2026-07-31T05:00:00.000Z): Raised from card 14's `docs` item, journaled there and not fixed, because fixing it is a behaviour change and that card is a move. Both entry paths are covered today — `tests/docs.spec.ts` asserts the boot path's fallback explicitly — which is how the asymmetry survived: each half is right on its own terms.
