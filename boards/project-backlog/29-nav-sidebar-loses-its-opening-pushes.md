---
column: review
labels: [extension, webview, bug]
priority: low
agent: opus-defects
live: false
updatedAt: 2026-07-31T12:40:00.000Z
---
# The sidebar's opening pushes can be lost to the load race, hiding Publish Mod

Found while giving the sidebar a presenter and a declared contract (card 14's
final item). Journaled there and carded here rather than fixed, because the fix
is a behaviour change and that card is a move.

`NavViewProvider.resolveWebviewView` sets the document's HTML and then
immediately kicks off two unprompted pushes — `pushSkills()` and, through
`watchManifest()`, `pushManifest()` (`src/nav/navView.ts`). Both are `async`, but
both can resolve before `media/nav.js` has attached its `message` listener, and
`media/nav.js` posts no handshake at all: it renders its rows from static data at
load and waits. So there is no message the sidebar can send to re-request either
fact.

This is the same load race cards 22-24 recorded for publish and New Project, and
it is *milder* here for a good reason — the sidebar is COMPLETE at load. A lost
push leaves a page that is stale rather than blank. But two of those stale states
are user-visible:

- **Publish Mod stays hidden.** The row ships `hidden` and only a `manifest` push
  with `hasManifest: true` reveals it (`media/nav.js:166-167`), so in a workspace
  that *is* a mod project the user's route to publishing is simply absent from the
  sidebar until the next event — a workspace-folder change, or the file watcher
  seeing `dcs-studio.toml` created or deleted. Neither happens in the common case
  of opening an existing project.
- **"Create a Mod" reads wrong**, pointing at `dcs.manifest.author` under a label
  that says start a new project when the workspace already has one.

The skills badge has the same exposure and matters less: a missed update badge is
a missed nudge.

## Fix sketch

Either give `media/nav.js` a boot handshake (`{type:"ready"}`) that the presenter
answers by re-pushing all three — `NavPresenter.pushSkills`/`pushManifest` are
already idempotent, and `pushStatus` would need the router's current status — or
have the shell re-push once the webview reports itself visible
(`WebviewView.onDidChangeVisibility`). The handshake is the shape cards 22-24
converged on and the one the declared contract would extend most naturally: it
adds one `toHost` message and no new state.

## Checklist

- [x] `media/nav.js` posts `{type:"ready"}` once its listener is attached
- [x] The contract declares it (`NavWebviewMessage`, `NAV_TO_HOST_KEYS`)
- [x] `NavPresenter` answers it with all three pushes, status included
- [x] The constructor-time pushes stay as the first chance (card 22's shape)
- [x] Unit + integration + e2e cover the handshake and the Publish-Mod recovery

## Comments

- **opus-defects** (2026-07-31T12:20:00.000Z): Claimed, and took the handshake option rather than `onDidChangeVisibility`, as the sketch preferred — it is the shape cards 22-24 converged on, and the visibility route would fire repeatedly for a reason unrelated to the race. Contract first: `{type:"ready"}` added to `NavWebviewMessage` and `NAV_TO_HOST_KEYS` (`src/core/app/webviewContract.ts:661-695`), with the `NavHostMessage` doc rewritten — the sidebar is no longer "the one webview that posts no handshake". `media/nav.js:198-204` posts it at the very bottom of the IIFE, after the `message` listener exists, so the answer cannot be lost the way the unprompted pushes could.
- **opus-defects** (2026-07-31T12:25:00.000Z): The presenter answers with the WHOLE opening state: `NavPresenter.ready()` (`src/core/app/navPresenter.ts:80-110`) pushes status, skills and manifest, and `handle` gained the `ready` case (`src/core/app/navPresenter.ts:126-139`, now `async` — `src/nav/navView.ts:73` voids it). Status was the one fact that only ever arrived by subscription, so the presenter gained a `status: () => DualBridgeStatus` dep (`src/core/app/navPresenter.ts:47-57`) fed by the router's own `current` (`src/nav/navView.ts:52-56`) — read on demand rather than cached, so there is no second copy of the pair to keep in step. Card 22's shape kept exactly: `resolveWebviewView`'s `pushSkills()` and `watchManifest()` are unchanged and are now the FIRST chance rather than the only one (noted at `src/nav/navView.ts:76-81`). Card 07's hand-rolled teardown is untouched.
- **opus-defects** (2026-07-31T12:32:00.000Z): Tests. Unit (`test/unit/nav/navPresenter.test.ts:169-215`): "answers ready with all three facts, so a lost opening push is recoverable", "reads the status as it is now rather than replaying the one it opened with", and "answers every ready, because the editor may re-resolve the view". Contract table (`test/unit/core/webviewContract.test.ts`): `NAV_DRIVES` gained `ready` — the `Record<Union["type"], …>` made that a compile error until it did — and the nav host→webview case now produces the whole declared set by driving the handshake alone. Integration (`test/integration/nav/navAndDocs.test.ts:142-163`): "answers the webview's boot handshake with the whole opening state" clears the unprompted pushes, sends `ready`, and asserts all three, with the status coming from the router's `current` (the fake grew that getter). e2e (`tests/nav.spec.ts:11-38`): "posts a boot handshake so the opening state can be re-asked for" and "the handshake answer reveals Publish Mod when the opening push was lost", the latter on a new `?scenario=modproject` fixture (`previews/fixtures/nav.js:16-33`) that answers ONLY the handshake — so the row's appearance is the handshake's doing and nothing else's. `tests/webviewContract.spec.ts:637-642`'s nav comment corrected.
- **opus-defects** (2026-07-31T12:40:00.000Z): Mutation evidence, both reverted from a copy-aside. (1) Removing the `postMessage({type:"ready"})` from `media/nav.js`: 3 e2e failures — both new nav cases and the nav contract set-equality, since the declared `toHost` list no longer matches what the page posts. (2) Removing the `case "ready"` from the presenter: 5 unit failures across both suites. Ran lint, `tsc -p ./`, `typecheck:tests`, the nav + contract unit suites (109 passed), the nav integration suite (20 passed) and `tests/nav.spec.ts` + `tests/webviewContract.spec.ts` (19 passed) for this card. The full serial gate run covering all five cards follows next, and the `## Gates` evidence is recorded from it.
