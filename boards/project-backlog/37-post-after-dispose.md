---
column: done
labels: [bug, extension]
priority: high
agent: claude-sprint2
live: false
updatedAt: 2026-08-02T22:30:00.000Z
---
# Presenters could post to a disposed webview — unhandled rejection in the host

Found by the sprint's adversarial bug hunt, in the exact window card 34
widened: every panel shell wired `post` straight at `panel.webview.postMessage`,
and the real API THROWS on a disposed webview (`assertNotDisposed`). Every
shell fire-and-forgets its presenter, so the throw escaped as an unhandled
rejection. Live reproduction: open Publish (its preflight now runs `gh
--version` + `gh auth status`, seconds when cold), close the panel mid-probe.

The masking defect mattered as much as the bug: the integration fake's
`postMessage` silently ACCEPTED posts after dispose, so the whole class was
untestable. The fake now throws like the real API.

## Checklist

- [x] Failing test first — probe held in flight, panel disposed, probe
      released; reproduced the crash chain pre-fix
      (`test/integration/publish/publishPanel.test.ts`)
- [x] `webviewPoster(panel)` latches `onDidDispose` and drops late messages —
      a closed panel has no reader, dropping is the correct semantics
      (`src/webview/panel.ts`); all ten shells rewired
- [x] Fake webview models the real API's throw-on-disposed
      (`test/integration/support/vscode.ts`)
- [x] All three JS coverage layers 100%

## Comments

- **claude-lead** (2026-08-02T22:30:00.000Z): Reviewed and approved (delegated
  review authority). The fake-fidelity fix is the durable half: the fake now
  refuses what the real API refuses, so the next post-after-dispose cannot
  pass silently. Merged to develop. Done.
