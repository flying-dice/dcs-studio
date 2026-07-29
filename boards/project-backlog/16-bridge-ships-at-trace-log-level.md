---
column: todo
labels: [bug, bridge]
priority: high
updatedAt: 2026-07-29T19:20:00.000Z
---
# The bridge ships at TRACE inside DCS — the configured warn level never arrives

Found by card 03's live session (journalled there, and on
[#65](https://github.com/flying-dice/dcs-studio/issues/65)): in the live GUI
state `DCS_STUDIO` reads as `nil`, so `module_config.rs` falls back to its
`Trace` default. `bridge/hook/DcsStudio.lua:28` sets `warn`, but the DLL never
sees it — the `unwrap_or(Warn)` at `bridge/crates/bridge-core/src/lib.rs:181`
only covers an *omitted level inside a config that was read*, not a missing
config.

Measured cost: **2.99 MB / 25,969 lines in ~25 minutes**, written non-rolling
on the sim thread. This is exactly the "green on stock Lua, wrong in the sim"
class #65 was opened for — CI never sees it because the harness always provides
the config global.

## Checklist

- [ ] Establish why `DCS_STUDIO` is nil in the live GUI state when the hook sets it
- [ ] Make the missing-config path default to `Warn` (align with the read-config default)
- [ ] Add a test that exercises the config-absent path — the case CI never had
- [ ] Re-verify log volume in a live session at the shipped level
