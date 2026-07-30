---
column: backlog
labels: [bug, webview]
priority: low
updatedAt: 2026-07-30T18:20:00.000Z
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
