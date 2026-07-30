---
column: review
labels: [bug, webview, extension]
priority: low
agent: opus-np-defects
live: false
updatedAt: 2026-07-30T10:25:00.000Z
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

- [x] `media/newproject.js` posts a boot message and the contract declares it
- [x] `NewProjectPresenter.handle` answers it with `pushInit()`
- [x] Unit: the handshake replays `init` after the constructor push
- [x] e2e: a preview whose fixture withholds the DOMContentLoaded `init` still renders once the handshake is answered

## Comments

- **opus-np-defects** (2026-07-30T10:25:00.000Z): Fixed the symmetrical way to cards 22 and 29, both halves plus the contract. `media/newproject.js:219-226` now posts `{type:"ready"}` at the bottom of its IIFE — after the `message` listener above it exists, so the answer cannot be missed in turn — and `NewProjectPresenter.handle` answers it at `src/core/app/newProjectPresenter.ts:127-132` by calling the existing `pushInit()`. The constructor push (`src/project/newProjectPanel.ts:66`) STAYS as the form's first chance rather than being replaced, which is only safe because `pushInit` re-reads `folder()`/`lastLocation()` and the webview re-renders whole: I pinned that idempotence rather than asserting it, at `test/unit/project/newProjectPresenter.test.ts:133-171` — three cases: the handshake alone renders the form, a handshake after the constructor push posts an IDENTICAL second `init` with no effect or dep call on the way, and a replay after the workspace changed describes the folder open NOW rather than echoing the first payload. Contract: `ready` declared in `NewProjectWebviewMessage` at `src/core/app/webviewContract.ts:449-457` and in `NEWPROJECT_TO_HOST_KEYS` at `src/core/app/webviewContract.ts:485`, with the `NewProjectHostMessage` doc at `src/core/app/webviewContract.ts:459-466` rewritten — `init` is no longer "the only one it cannot ask for". Two stale neighbours went with it: the manifest bootstrap note (`src/core/app/webviewContract.ts:509-518`) and the docs one (`src/core/app/webviewContract.ts:556-567`) both described New Project as a panel that can still lose its opening push.
- **opus-np-defects** (2026-07-30T10:25:00.000Z): Tests, and the mutations that prove they bite. Unit: `NEWPROJECT_DRIVES` gains `ready` (`test/unit/core/webviewContract.test.ts:860`) — the plan is an exhaustive `Record` over the union, so the union and the drive plan cannot drift; and the host→webview set-equality now drives `init` through `handle({type:"ready"})` instead of `pushInit()` (`test/unit/core/webviewContract.test.ts:1274-1279`), so the reply is what produces the declared message. e2e: `previews/fixtures/newproject.js:70-74` answers `ready` with the same `init` the host does, and a new `?scenario=lostinit` (`previews/fixtures/newproject.js:100-104`) WITHHOLDS the DOMContentLoaded push — card 29's fixture pattern — so the two new cases at `tests/newproject.spec.ts:48-71` are the handshake being posted and the whole form arriving with the constructor's push lost. Mutation checks, both run: deleting the `postMessage` fails 3 e2e (the two new cases plus the `toHost` set-equality in `tests/webviewContract.spec.ts:459`); deleting the `ready` drive entry fails 2 unit. Gates: `lint`, `compile`, `typecheck:tests` clean; 113 unit in the two touched files; 31 e2e across `newproject.spec.ts` + `webviewContract.spec.ts` green.
