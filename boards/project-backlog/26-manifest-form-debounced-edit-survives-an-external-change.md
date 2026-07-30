---
column: review
labels: [bug, webview]
priority: med
agent: opus-defects
live: false
updatedAt: 2026-07-31T11:00:00.000Z
---
# The manifest form's debounced edit survives an external change and overwrites it

Found while giving the manifest form a presenter (card 14's `manifest` item).
Preserved verbatim there rather than fixed, because fixing it is a behaviour
change and that card is a move.

`media/manifest.js` debounces its `edit` post: a keystroke arms a 200ms timer
(`media/manifest.js:28-34`) which then emits the WHOLE file from `state.model`.
The `external` handler — the document changed outside the form, i.e. a raw-text
edit, an undo, a revert, a `git checkout`, another extension's formatter —
re-seeds the model and re-renders (`media/manifest.js:369-372`) but **does not
clear that timer**.

So a user who types in the form and, within 200ms, has the file changed under
them gets:

1. their keystroke discarded (the model is replaced by the external text — this
   part is arguably correct: the document is the source of truth);
2. the still-pending timer firing anyway and posting an `edit` built from the
   NEW model — which the host applies as a `WorkspaceEdit`
   (`src/core/app/manifestPresenter.ts:161-165`) as long as it differs from the
   document by so much as whitespace.

`emitToml` re-emits canonically, so the second step rewrites a file that was
just changed on disk into the form's own formatting and marks it dirty, moments
after an external change and attributed to a keystroke the user already lost.
The host's identical-text guard is the only thing that sometimes saves it, and
only when the emit happens to be byte-identical.

The fix is one line in the webview half — clear `editTimer` when re-seeding from
`external` — plus a case in `tests/manifest.spec.ts` driving a keystroke and an
`external` push inside the debounce window.

## Checklist

- [x] Clear the pending debounce timer when re-seeding from `external`
- [x] e2e: a keystroke and an `external` push inside the debounce window post no `edit`
- [x] e2e: the form is still live afterwards (a later keystroke reaches the document)

## Comments

- **opus-defects** (2026-07-31T10:50:00.000Z): Claimed and fixed at `media/manifest.js:369-378` — the `external` handler now clears `editTimer` (and nulls it) before re-seeding the model. Chose CANCEL over flush-first, deliberately: the pending timer emits from `state.model`, which is the very object being replaced on the next line, so a "flush" would not carry the user's keystroke anywhere — it would post the NEW model's canonical TOML back over a file that had just changed on disk. There is no ordering in which the keystroke survives (step 1 of the card, the model being replaced, is correct on its own terms), so the only question was whether the file gets a spurious rewrite, and it now does not. For undo / revert / `git checkout` that is exactly the right UX: the document wins, and the editor's own undo stack keeps one step per external change instead of gaining a phantom form-formatting commit on top.
- **opus-defects** (2026-07-31T10:55:00.000Z): Tests in `tests/manifest.spec.ts:249-276` — "an external change cancels the keystroke still inside the debounce window" dispatches the `input` event and the `external` push inside ONE `page.evaluate`, so the race is pinned rather than timed, then waits 500ms (well past the 200ms debounce) and asserts no `edit` was posted at all. "a keystroke after an external change still reaches the document" (`tests/manifest.spec.ts:278-290`) pins that only the pending timer was cancelled and the form stays live, emitting the re-seeded model plus the new keystroke.
- **opus-defects** (2026-07-31T11:00:00.000Z): Mutation evidence — deleting the `if (editTimer) { clearTimeout… }` block fails exactly the new debounce case (28 passed, 1 failed), and the mutation was reverted from a copy-aside. Ran lint, `typecheck:tests` and the whole of `tests/manifest.spec.ts` (29 passed) for this card; the full serial gate run including the 100% coverage gates is deferred to one run covering all five cards on this branch, and the `## Gates` evidence will be recorded from it.
