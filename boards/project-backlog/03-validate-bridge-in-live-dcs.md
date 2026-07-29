---
column: blocked
labels: [bridge, lua, tests]
priority: high
agent: claude
live: false
status: blocked — needs a machine running DCS
updatedAt: 2026-07-29T05:52:00.000Z
---
# Validate the reworked bridge against a live DCS

[Issue #65](https://github.com/flying-dice/dcs-studio/issues/65). **Every bridge
change from #15 is verified against PUC liblua5.1 on Linux and has never run
inside DCS.** `.github/workflows/ci.yml` installs `liblua5.1-0-dev` and runs the
Rust suite there; DCS's own state is different — ED strips parts of the `debug`
library, which is why `bridge/crates/bridge-core/lua/debug_engine.lua` has a
decline path at all.

#68 calls this "the highest-value hour available on this codebase", and pairs it
with card 04 (#32), which is confirmable in the same session.

Drive it with the `dcs-dev` skill (`.claude/skills/dcs-dev/SKILL.md`).

## Checklist

- [ ] Inspect a function with side effects in the Console Explorer — confirm the signature answer is produced **without** running it
- [ ] Confirm the GUI bridge survives a state where the debug engine declines
- [ ] Hold a breakpoint; watch frame time during the hold, then confirm a prompt resume
- [ ] Exercise the file and sqlite methods, including a NULL bind and a refused path
- [ ] Check `dcs_studio_*.log` for volume at the shipped level, and for any `lua_atpanic` line

## Comments

- **claude** (2026-07-29T05:52:00.000Z): Blocked on hardware, and unambiguously so. Every item on the checklist requires DCS World running: the Console Explorer signature probe, the debug engine's decline path, frame time during a held breakpoint, and the shipped-level log volume. DCS is Windows-only and this session has no sim. Nothing about it can be faked usefully — the whole point of the card is that PUC liblua5.1 on Linux is *not* the environment the risk lives in, since ED strips parts of the `debug` library in DCS's own state.
- **claude** (2026-07-29T05:52:00.000Z): Confirmed the Linux half is genuinely green, so the residual really is DCS-specific rather than a broken baseline: installed `liblua5.1-0-dev` and ran the Rust workspace suite in this container. Pair this with card 04 when a machine with DCS is available — #68 calls the combined session the highest-value hour on this codebase, and both cards are checklist-ready.
