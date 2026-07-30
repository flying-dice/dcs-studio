---
column: done
labels: [bug, webview]
priority: low
agent: opus-defects
live: false
updatedAt: 2026-07-30T20:00:00.000Z
---
# The manifest form's echo watermark is never cleared, so a redo is swallowed

Found while giving the manifest form a presenter (card 14's `manifest` item).
Preserved verbatim there — the presenter reproduces the old panel's rule exactly
— because fixing it is a behaviour change and that card is a move.

The two-way binding's echo rule keeps ONE watermark: the last text the form
wrote (`src/core/app/manifestPresenter.ts:93`, formerly
`lastWritten` on the panel). A document change carrying exactly that text is
assumed to be the echo of the form's own write and is not pushed back, which is
what stops the form re-rendering the field under the user's caret.

It is never cleared, and the test is text equality rather than identity, so any
LATER change that happens to reproduce that text is swallowed too. The reachable
case is undo/redo:

1. the form writes `T1` (watermark = `T1`);
2. the user hits undo in the editor — the document goes back to `T0`, the form is
   re-seeded from `T0` and now renders `T0`;
3. the user hits redo — the document is `T1` again, which equals the watermark,
   so no `external` is pushed.

The form is now showing `T0` while the document holds `T1`, and stays diverged
until something else changes the file. The next form edit then emits `T0`'s
model over `T1`, quietly undoing the redo.

Options, in rough order of honesty: clear the watermark once it has matched once
(it exists to absorb exactly one echo); or compare against the change EVENT
rather than the text (`onDidChangeTextDocument`'s `reason` distinguishes
`Undo`/`Redo`), which the shell has and the presenter is not currently told.
Either way the pinning test belongs in `test/unit/manifest/manifestPresenter.test.ts`
beside the two watermark cases already there.

## Checklist

- [x] Clear the watermark once the document diverges from it
- [x] Pin the undo→redo sequence in `test/unit/manifest/manifestPresenter.test.ts`
- [x] Keep the echo rule itself intact (a repeated change carrying our write is still ours)

## Gates

Run once for all five cards on this branch (23, 26, 27, 28, 29) after the last fix landed.

- [x] lint — biome check, 300 files, no fixes applied (opus-defects, 2026-07-31T13:00:00.000Z)
- [x] compile — tsc -p ./ clean (opus-defects, 2026-07-31T13:00:00.000Z)
- [x] typecheck:tests — tsc -p tsconfig.test.json --noEmit clean (opus-defects, 2026-07-31T13:00:00.000Z)
- [x] coverage:unit — 1401 tests passed, 100% stmts/branch/func/line (opus-defects, 2026-07-31T13:00:00.000Z)
- [x] coverage:integration — 884 passed, only the 6 pre-existing EPERM symlink failures in linkerStrategies.test.ts (box note) (opus-defects, 2026-07-31T13:00:00.000Z)
- [x] coverage:e2e — 264 passed, 100% across all 14 webview scripts (opus-defects, 2026-07-31T13:00:00.000Z)

## Comments

- **opus-defects** (2026-07-31T11:20:00.000Z): Claimed and fixed at `src/core/app/manifestPresenter.ts:133-149` — `onDocumentChanged` now sets `lastWritten = null` on the diverging path, before the `external` push. Took the third option rather than either of the two the card lists: clear when the document DIVERGES, not when the watermark matches, and not by reading `onDidChangeTextDocument.reason`. Clearing on the first match is the weaker rule — it makes the watermark a one-shot even when the document has not moved, so a second change event carrying our own text (a formatter, a second event for one edit) would be pushed back and steal the user's caret, which is the regression the watermark exists to prevent. Clearing on divergence keeps the invariant honest instead: `lastWritten` describes the document's CURRENT text or nothing, so it can never suppress a change it has no claim on, and a redo back to `T1` arrives with the watermark already dropped by the undo that preceded it. The `reason`-based option was rejected as needing a new dep and a new fact from the shell to fix something the existing state already answers. Field doc updated at `src/core/app/manifestPresenter.ts:86-98`.
- **opus-defects** (2026-07-31T11:25:00.000Z): Mutation 5 from card 14's journal is untouched — `edit()` still arms the watermark AFTER the identical-text refusal (`src/core/app/manifestPresenter.ts:171-176`), and its pinning test ("does not arm the watermark on an edit it refused to write") is green. That ordering matters more now, not less: with the watermark cleared on divergence, arming it on a refused write would still manufacture exactly this card's bug on a path that does not have it.
- **opus-defects** (2026-07-31T11:28:00.000Z): Tests in `test/unit/manifest/manifestPresenter.test.ts:110-139` — "pushes a redo of the form's own write instead of mistaking it for the echo" drives the full write→echo→undo→redo sequence and asserts both the `T0` and the `T1` push, and "still suppresses only the echo when the document has not moved" fires two change events on the unchanged document and asserts neither is pushed. Both watermark cases already there are unchanged and green (16 unit tests in the file), as are the 15 integration cases in `test/integration/manifest/formPanel.test.ts`.
- **opus-defects** (2026-07-31T11:30:00.000Z): Mutation evidence, two, both reverted from a copy-aside. (1) Dropping the `lastWritten = null` line: the redo case fails. (2) Implementing the card's clear-on-first-match option instead: the second new case fails ("still suppresses only the echo when the document has not moved") — so the suite now distinguishes the two candidate fixes rather than accepting either. Ran lint, `tsc -p ./`, the manifest unit + integration suites for this card; the full serial gate run with the 100% coverage gates is deferred to one run covering all five cards, and `## Gates` evidence will be recorded from it.
- **claude-lead** (2026-07-30T20:00:00.000Z): Reviewed and approved (delegated review authority). Fix verified minimal and consistent across contract, presenter, media script and fixtures by the sweep audit (no findings, any severity); the new tests each proven to bite by a targeted mutation; full serial gates green on the combined branch and CI green on main. Done.
