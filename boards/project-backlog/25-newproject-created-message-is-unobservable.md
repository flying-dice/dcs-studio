---
column: backlog
labels: [webview, extension, cleanup]
priority: low
live: false
updatedAt: 2026-07-30T09:40:00.000Z
---
# New Project panel: the `created` message can never be seen

Found by card 14's `newproject`-presenter extraction (journalled there),
preserved verbatim rather than changed mid-refactor. Declared honestly in the
contract as the only `silent` message on this panel
(`src/core/app/webviewContract.ts`, `NEWPROJECT_PROTOCOL.silent`).

The host posts `created` and the webview handles it
(`media/newproject.js:213-215`), but all the handler does is set
`state.creating = false` without re-rendering — and in **both** branches the
panel is destroyed immediately afterwards:

- in place: `created` is posted, then the `close` effect disposes the panel
  (`src/core/app/newProjectPresenter.ts`, the in-place branch);
- new folder: `created` is posted, then the `openFolder` effect reloads the whole
  extension host.

So the latch it drops belongs to a form that is already going away. It is either
dead weight to remove from both halves, or the sign of a missing state — a
"Created — opening…" pane would be a real use for it, and would also cover the
case where `vscode.openFolder` is slow enough for the user to wonder whether
Create did anything.

Deciding which is the work; both halves and the contract entry move together
either way.

## Checklist

- [ ] Decide: remove `created` from both halves, or give it something to render
- [ ] Update `NEWPROJECT_PROTOCOL` (`silent` list or the union) to match
