---
column: backlog
labels: [bug, webview]
priority: med
updatedAt: 2026-07-30T18:20:00.000Z
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
