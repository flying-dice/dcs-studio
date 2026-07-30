---
column: review
labels: [bug, bridge]
priority: high
agent: opus-getpause
live: false
status: Fixed and live-verified — getMissionLoaded is the killer (getPause is innocent)
progress: 100
updatedAt: 2026-07-30T12:10:00.000Z
---
# `DCS.getPause()` / `DCS.getMissionLoaded()` via GUI-bridge eval crash DCS instantly

> **Correction from the fix session (see the journal):** only
> `DCS.getMissionLoaded()` crashes, and only with a mission loaded.
> `DCS.getPause()` is innocent — it answers normally at the menu and in a
> mission. The title is kept as filed.

Incidental find from card 18's discriminator session (journalled there):
evaluating `DCS.getPause()` or `DCS.getMissionLoaded()` through the GUI
bridge's `eval` kills DCS on the spot — `C0000005 ACCESS_VIOLATION` in
`lua_pushnil` under a deeply recursive `ED_lua_copyindex` chain. Unlike the
card-18 unload crash, this one *does* write a `.crash`/`.dmp` pair
(`Logs\dcs.20260729-193806.crash` on this machine; sim log archived in the
session scratchpad as `dcs-D0-probecrash.log`).

Any user with the Lua console open can type these — they are obvious,
documented-looking DCS control API getters — and take their sim down with one
Enter. The bridge should deny or wrap them before a user finds this the hard
way.

Open questions for whoever picks this up:

- Is the fault in ED's serialization of those getters' return values across
  the GameGUI state (the `ED_lua_copyindex` recursion suggests the result
  table is cyclic or huge), and are other `DCS.*` getters affected?
- Deny-list vs safe-wrap: a pcall inside the eval chunk will NOT help if the
  fault is a hard access violation in the C layer — test whether any Lua-side
  guard survives it before choosing a shape.
- The eval path is `bridge/crates/bridge-core/lua/gui_methods.lua:99`
  (`loadstring`); the fix likely belongs where results are serialized back.

## Checklist

- [x] Reproduce in a throwaway sim session; capture whether pcall contains it
- [x] Survey which other `DCS.*` getters trigger the same recursion
- [x] Implement deny/wrap with a truthful error message to the console user
- [x] Cover the guard in the Rust suite; live-verify the console no longer crashes the sim

## Comments

- **opus-getpause** (2026-07-30T12:10:00.000Z): **Fixed and live-verified — and the card's title was half wrong: `DCS.getPause()` is innocent, `DCS.getMissionLoaded()` is the killer.**

  **Mechanism.** Read both dumps frame by frame (`dcs.20260729-193806.crash` from card 18's session, and `dcs.20260730-022117.crash` which I produced myself). Innermost-to-outermost the stack is: our DLL's frame drain → `lua_pcall` of the eval'd chunk → **`DCS: SW+0x481D63`** (the getter's C implementation) → **`ED_lua_copyindex` × 598** (997 in my dump) → `lua_pushnil` → `C0000005`. So the fault is *inside DCS's own getter*, in ED's cross-state value copy, which recurses on a graph it never terminates on until the thread stack is gone. **Our serialization never runs** — the value never comes back. Nothing in `serialize_lua_to_json` or the RT encoder is implicated, and there was nothing to harden there (both already have depth/cycle guards).

  **Live findings, DCS 2.9.27.25340, five launches.** At the **main menu** `DCS.getMissionLoaded()` returns `nil` and the sim lives. With a **mission loaded** (`loadMission Done: Control passed to the player`, the same state as yesterday's crash) it kills the process instantly, and **`pcall` does not contain it** — `pcall(DCS.getMissionLoaded)` died exactly like the bare call, as the card suspected. It is equally fatal through `net.dostring_in("server", …)`, so **no environment offers a safe delegate**. `DCS.getPause()` answered `true` four times over, at the menu and in a mission, bare and under pcall.

  **Blast radius — one function.** Measured safe with a mission loaded, each in its own eval: `getPause`, `getModelTime`, `getRealTime`, `getMissionName`, `getMissionFilename`, `getMissionDescription`, `getMissionTheatre`, `getMissionOptions`, `getMissionResult`, `getMissionPersistenceData`, `getCurrentMission` (the big one), `getUserOptions`, `getSimulatorMode`, `getAvailableCoalitions`, `getPlayerUnit`, `getPlayerUnitType`, `getPlayerCoalition`, `getUnitProperty`, `isMultiplayer`, `isServer`. Table-returning getters copy across states fine, so this is not "ED can't copy tables" — it is one broken getter.

  **Fix shape — a guarded environment, not a text deny-list.** `rt.lua` (RT bumped v2→v3) now builds the environment user chunks run in: `_G` for everything, with `DCS` replaced by a snapshot whose `getMissionLoaded` raises a truthful error naming the getter, the crash, and the alternatives (`getMissionName` / `getModelTime`). `RT.guard_chunk` is applied in RT's own `compile` (so `repl_eval`/`inspect`/`export` get it, in every env — the RT source travels into `server`/`config`/`export` via `dostring_in`), in `gui_methods.lua`'s `eval` handler (which loads its own chunk), and in the debug engine for both `debug_run` chunks and watch/hover/console evaluations (`RT_GLOBALS()`, a soft dependency with a `_G` fallback). Because the guard is the *table the chunk sees*, `DCS["get".."MissionLoaded"]()` is blocked too; a source scan would have missed it. Snapshot rather than bare `__index` proxy so `pairs(DCS)` still enumerates all 223 keys; `__index`/`__newindex` cover late keys and new writes. The host's real globals are untouched, so DCS's own UI Lua and other users' hooks are unaffected.

  **Gates.** `cargo fmt --all`, `cargo clippy --workspace --all-targets -D warnings` clean; `cargo test --workspace -- --include-ignored --skip lua_panic` with DCS's `lua.dll` on PATH: **128 lib + 10/10 jsonrpc_server + 4 + 12 + 1 + 1 + 2 + 3 + 5 all pass**. New coverage: `surface.rs::rt_guards_the_process_killing_dcs_getters` (block, dynamic spelling, pass-through, `pairs`, global read/write-through, late keys, DCS-swap re-guard, no-DCS state) and `tests/eval_guard.rs` (the `eval` RPC through the real registered handler). The real getter is untestable off-sim by definition, so a stub records whether it was ever called — it never is. OpenRPC goldens + `docs/03-reference/02-bridge-api-gui.md` regenerated for the two amended descriptions.

  **Live verification** (deployed from this tree, mission loaded, one launch, sim alive throughout and **no new `.crash`/`.dmp`**): `eval "return DCS.getMissionLoaded()"` → truthful `-32603`; under `pcall` → `ok=false` with the same message; `DCS["get".."MissionLoaded"]()` → blocked; `repl_eval` in `gui` **and** in `server` → `{ ok = false, err = … }`; `debug_run` on a chunk calling it → `ran = false` with a traceback, and its earlier `print("before")` still streamed to the console; `DCS.getMissionName()/getPause()/getModelTime()` → `A-10A - IA - Caucasus - Free flight/true/0`; `pairs(DCS)` → 223. Torn down with `DCS.exitProcess()`; deployment left as this tree's build. Logs archived in the session scratchpad as `c19-run1-CRASH-getMissionLoaded-{dcs,gui}.log` and `c19-verify-{dcs,gui}.log`.

  **Worth reporting upstream to ED** — this is an engine bug (any user with the Lua console of *any* tool can take their sim down with it), and our guard only protects users going through DCS Studio.
