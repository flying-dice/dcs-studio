---
column: todo
labels: [debugger, cleanup]
priority: low
agent: unassigned
live: false
updatedAt: 2026-08-02T00:00:00.000Z
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

- [ ] Confirm nothing produces `dispatched` on `debug_run` any more
- [ ] Remove the dead branch + comment in dapTranslation.ts:306-320
- [ ] Unit layer stays 100% per file
