---
column: done
labels: [debugger, cleanup]
priority: low
agent: claude-lead
live: false
updatedAt: 2026-08-02T23:00:00.000Z
---
# Stale `dispatched` fast-path branch in dapTranslation.ts

Found during the spec-drift audit of `spec/stories/020-debug-lua-breakpoints.story.md`.

`src/core/domain/dapTranslation.ts:306-320` still documents "A mission run
resolves `{ dispatched: true }`" and carries the matching branch — but no
`debug_run` returns `dispatched` any more. Only `mission_boot` does
(`bridge/crates/bridge-core/lua/gui_methods.lua:303`); the mission-side
`debug_run` blocks (`bridge/crates/bridge-core/lua/mission_methods.lua:137-144`).

The story's behaviour is correct; the code comment and the dead `dispatched`
branch are the stale artefacts. Remove the branch and comment (or prove a
caller still reaches it), keeping the coverage gates green.

## Checklist

- [x] Confirm nothing produces `dispatched` on `debug_run` any more — repo-wide
      sweep: the only `{ dispatched = true }` producer is the `mission_boot`
      RPC (`gui_methods.lua:301-306`); both bridges' `debug_run` handlers block
- [x] Remove the dead branch + comment — and the phantom followed the branch
      out: `dispatched?` left the port (`debugBridge.ts`), the client
      (`client.ts`), the integration fake, and the two tests that modeled a
      response shape the bridge never sends
- [x] All three JS layers 100% (unit, integration, e2e)

## Comments

- **claude-lead** (2026-08-02T23:00:00.000Z): Done by the lead directly. The
  branch was not merely dead — it kept a false belief alive in four other
  files (port type, client type, fake, two tests), each teaching the next
  reader that a dispatched debug_run exists. All of it went together.
