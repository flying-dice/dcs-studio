---
column: backlog
labels: [extension, webview, bug]
priority: low
updatedAt: 2026-07-31T09:00:00.000Z
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
