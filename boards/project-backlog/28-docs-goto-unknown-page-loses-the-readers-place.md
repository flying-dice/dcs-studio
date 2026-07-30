---
column: review
labels: [bug, webview]
priority: low
agent: opus-defects
live: false
updatedAt: 2026-07-31T12:00:00.000Z
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

## Checklist

- [x] `goto` ignores a page id the manual does not have
- [x] The reader's persisted page is not overwritten on the way
- [x] e2e: the unknown-goto case pins the reader's place instead of Overview

## Gates

Run once for all five cards on this branch (23, 26, 27, 28, 29) after the last fix landed.

- [x] lint — biome check, 300 files, no fixes applied (opus-defects, 2026-07-31T13:00:00.000Z)
- [x] compile — tsc -p ./ clean (opus-defects, 2026-07-31T13:00:00.000Z)
- [x] typecheck:tests — tsc -p tsconfig.test.json --noEmit clean (opus-defects, 2026-07-31T13:00:00.000Z)
- [x] coverage:unit — 1401 tests passed, 100% stmts/branch/func/line (opus-defects, 2026-07-31T13:00:00.000Z)
- [x] coverage:integration — 884 passed, only the 6 pre-existing EPERM symlink failures in linkerStrategies.test.ts (box note) (opus-defects, 2026-07-31T13:00:00.000Z)
- [x] coverage:e2e — 264 passed, 100% across all 14 webview scripts (opus-defects, 2026-07-31T13:00:00.000Z)

## Comments

- **opus-docs** (2026-07-31T05:00:00.000Z): Raised from card 14's `docs` item, journaled there and not fixed, because fixing it is a behaviour change and that card is a move. Both entry paths are covered today — `tests/docs.spec.ts` asserts the boot path's fallback explicitly — which is how the asymmetry survived: each half is right on its own terms.
- **opus-defects** (2026-07-31T11:55:00.000Z): Claimed and fixed in the webview half, as the card called it. `media/docs.js:51-61`: `render` no longer falls back to `pages[0]` — an id the manual does not have renders nothing at all, so the reader keeps their place AND their persisted page (the old fallback overwrote `vscode.setState({page})` with Overview on the way, which is why reopening the panel did not recover it). Deliberately fixed at `render` rather than by guarding the `goto` case: that fallback WAS the disagreement, and with it gone the boot path and the `goto` path share one rule instead of two. The boot ternary now reads through the same predicate (`known`, `media/docs.js:13-15`, used again at `media/docs.js:18-23`). The empty-manual guard is unchanged — `if (!page) return` was already there and now carries this case too. No host change: `DocsPresenter.navigate`'s `if (page)` rule is still right, since the page ids only exist in `media/docs-content.js`.
- **opus-defects** (2026-07-31T11:58:00.000Z): Tests in `tests/docs.spec.ts:95-118`. "an unknown goto target leaves the reader where they were" replaces "an unknown goto target falls back to the first page rather than blanking", which pinned exactly the bug: it navigates the reader to Publishing first, sends the bad `goto`, then asserts both the title AND `vscode.getState()` still say `publishing`. "a goto with no page at all is ignored" covers the empty-`page` half from the webview's side. The two boot-path fallbacks ("a deep link to a page that no longer exists…", "a stored page that no longer exists…") are untouched and green — those SHOULD land on the first page, because there is no reader's place to keep yet. 17 cases in the file, all green.
- **opus-defects** (2026-07-31T12:00:00.000Z): Mutation evidence — restoring the `|| pages[0]` fallback fails exactly the new case (16 passed, 1 failed); reverted from a copy-aside. Ran lint, `typecheck:tests` and `tests/docs.spec.ts` for this card; the full serial gate run with the 100% coverage gates is deferred to one run covering all five cards on this branch, and the `## Gates` evidence will be recorded from it.
