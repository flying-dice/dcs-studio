---
column: backlog
labels: [bug, webview, extension]
priority: low
live: false
updatedAt: 2026-07-30T09:40:00.000Z
---
# New Project panel: no boot handshake at all, so a lost `init` is unrecoverable

Found by card 14's `newproject`-presenter extraction (journalled there),
preserved verbatim rather than fixed mid-refactor. The same family as card 22,
one step worse.

`media/newproject.js` posts **nothing** at load. It declares two messages,
`browse` and `create`, and both are user actions; the page renders only when the
host pushes `init`, which the panel does unprompted from its constructor
(`src/core/app/newProjectPresenter.ts#pushInit`, called at
`src/project/newProjectPanel.ts:66`) — before the webview document has
necessarily loaded and attached its `message` listener.

Card 22 fixed the publish panel by answering its boot `refresh` unconditionally.
New Project has no equivalent to answer: if that one push loses the load race
the panel is a blank `<div id="app">` with no button, no retry and no way for
the user to ask again. Every other covered panel posts a boot message
(`ready`/`refresh`) from the bottom of its IIFE.

The fix is symmetrical with card 22 and needs both halves: post a boot message
from `media/newproject.js` (e.g. `{type:"ready"}`), declare it in
`NewProjectWebviewMessage` / `NEWPROJECT_TO_HOST_KEYS`
(`src/core/app/webviewContract.ts`), and answer it in
`NewProjectPresenter.handle` by calling the existing `pushInit()` — which is
already idempotent, so a second `init` is a re-render rather than a new rule.

## Checklist

- [ ] `media/newproject.js` posts a boot message and the contract declares it
- [ ] `NewProjectPresenter.handle` answers it with `pushInit()`
- [ ] Unit: the handshake replays `init` after the constructor push
- [ ] e2e: a preview whose fixture withholds the DOMContentLoaded `init` still renders once the handshake is answered
