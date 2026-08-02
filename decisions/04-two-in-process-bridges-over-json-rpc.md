---
status: Accepted
date: 2026-07-14
---
# Decision 04 — Two in-process bridges, speaking JSON-RPC over localhost

## Context

The live features — Lua REPL, state explorer, step debugger, unit-database export
— all need to run code inside a running DCS and get answers back. DCS exposes two
different Lua states for that, and they are not interchangeable: the GameGUI
hooks state (`DCS.*`, `net.*`) exists from the main menu onward, while the
mission scripting sandbox (`trigger.action`, `coalition`, `world`) exists only
while a mission is loaded, and ships locked down until `MissionScripting.lua` is
desanitized.

Dated from `ccf1dbe` ("Split the in-DCS bridge into GUI + mission DLLs with a
shared core workspace"), which is where one bridge became two.

## Decision

Two native DLLs, injected into DCS's Saved Games folder alongside a GameGUI hook
(`bridge/hook/DcsStudio.lua`): `dcs_studio_gui.dll` on `127.0.0.1:25569` and
`dcs_studio_mission.dll` on `127.0.0.1:25570`. They share `bridge-core`, which
holds the JSON-RPC server, router, protocol, path guard and the Lua chunks both
load.

The wire protocol is **JSON-RPC 2.0 over localhost HTTP and WebSocket**, and each
bridge describes its own surface with an OpenRPC 1.3.2 document served via
`rpc.discover` and checked into the repo. That makes the bridges drivable by
`curl`, by scripts, and by AI agents with no extension involved — which is what
`skills/dcs-studio/SKILL.md` and `docs/03-reference/01-bridge-api.md` document.

Rust, not C++ or Lua alone, and under a strict lint policy: the workspace denies
`unwrap_used` and `expect_used`, because this code runs in-process on the sim
thread where a panic takes the user's flight with it.

## Consequences

- Any tool that can speak HTTP can drive a running sim, and the API surface is
  discoverable rather than documented by hand — the Markdown references are
  generated from the OpenRPC JSON and pinned to it by a golden test.
- Two bridges means two lifetimes, and "is a mission running" becomes a question
  with a wrong easy answer. Issue #32 (board card 04) is exactly that mistake.
- The mission bridge cannot boot without a desanitized `MissionScripting.lua`, so
  a reversible sanitize/desanitize toggle with an automatic backup is a required
  part of the product rather than a convenience.
- A localhost port is an attack surface for anything already on the machine,
  which is why `path_guard.rs` exists and why its hardening was treated as a
  data-loss defect (`docs/04-quality/02-testing-audit-2026-07.md:328-332`).
- Panic paths are the failure mode that matters. Hence `lua_atpanic`
  (`bridge/crates/bridge-core/src/lua_panic.rs`, #62), and the unresolved
  prevention half in #63.
- The Rust half is measured by `cargo llvm-cov`; the ~2,050 lines of Lua it loads
  are executed but not measured. That gap is #66 (board card 05).
