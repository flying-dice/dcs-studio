# Eagle Dynamics: `DCS.getMissionLoaded()` crashes DCS from a GUI-state Lua call

> **Draft — for the owner to file.** Nothing has been reported to Eagle
> Dynamics. This page is the bug report, written while the dumps and the live
> session were fresh. Suggested destination: the ED bug-report forum / support
> channel, with the two `.crash`/`.dmp` pairs attached.

## Summary

Calling `DCS.getMissionLoaded()` from Lua running in the **GameGUI state**, with
a mission loaded, terminates the DCS process immediately with a
`C0000005 ACCESS_VIOLATION`. The fault is inside DCS's own getter: `ED_lua_copyindex`
recurses until the thread stack is exhausted, and the access violation lands in
`lua_pushnil`.

`pcall` does not contain it — it is a hardware fault in a C recursion, not a Lua
error — so no script-side guard exists. Any user with a Lua console in any tool
(ours, or anyone's) can take their own sim down with one line, and the getter
looks like exactly the kind of documented control-API call a user would try.

- **Version:** DCS 2.9.27.25340
- **Reproducibility:** 100% with a mission loaded; harmless at the main menu
- **Severity:** process termination, no user-facing error, mission progress lost

## Environment

- DCS World OpenBeta 2.9.27.25340, Windows 11
- Mission: stock *A-10A — IA — Caucasus — Free flight* (any loaded mission
  reproduces it; the crash is not mission-specific)
- Lua executed in the GameGUI state, both from a hook and through
  `net.dostring_in`

## Steps to reproduce

1. Launch DCS and load any mission — wait for
   `loadMission Done: Control passed to the player` in `dcs.log`.
2. From Lua in the GameGUI state (any GUI-side hook, or a tool's console),
   evaluate:

   ```lua
   return DCS.getMissionLoaded()
   ```

3. The process dies on the spot. A `.crash`/`.dmp` pair is written to `Logs\`.

**Variants tested, all fatal in the same way:**

- `pcall(DCS.getMissionLoaded)` — dies identically; the protected call gives no
  protection.
- `net.dostring_in("server", "return DCS.getMissionLoaded()")` — dies
  identically, so delegating to another state is not a workaround either.

**Not fatal:** the same call **at the main menu**, with no mission loaded,
returns `nil` and the sim carries on. The mission-loaded state is required.

## Stack (read frame by frame from two dumps)

Innermost to outermost:

```
lua_pushnil                    <-- C0000005 ACCESS_VIOLATION here
ED_lua_copyindex   x598        (997 in the second dump)
DCS: SW+0x481D63               <-- the getter's C implementation
lua_pcall                      (of the evaluated chunk)
<caller>
```

The recursion count differs between dumps (598 and 997) while everything else
matches, which is what a runaway recursion terminated by stack exhaustion looks
like — ED's cross-state value copy walking a graph it never terminates on.

The value never returns to Lua, so nothing on the caller's side is implicated:
no serializer, no encoder, no depth limit of ours is ever reached.

## Blast radius — one function

Twenty sibling getters were measured **safe** in the same live session, with a
mission loaded, each evaluated in its own call:

`getPause`, `getModelTime`, `getRealTime`, `getMissionName`,
`getMissionFilename`, `getMissionDescription`, `getMissionTheatre`,
`getMissionOptions`, `getMissionResult`, `getMissionPersistenceData`,
`getCurrentMission`, `getUserOptions`, `getSimulatorMode`,
`getAvailableCoalitions`, `getPlayerUnit`, `getPlayerUnitType`,
`getPlayerCoalition`, `getUnitProperty`, `isMultiplayer`, `isServer`.

`getCurrentMission` in particular returns a large table across the same state
boundary without incident, so this is **not** "the cross-state copy cannot
handle tables" — it is one broken getter.

(`DCS.getPause()` is named here deliberately: our own bug report originally
blamed it, and the dumps exonerated it. It answers `true`/`false` at the menu
and in a mission, bare and under `pcall`.)

## Artifacts to attach

Both `.crash`/`.dmp` pairs are in `Logs\` on the machine that produced them:

- `dcs.20260729-193806.crash` (and its `.dmp`) — first occurrence, incidental
  find during unrelated testing. Sim log archived as `dcs-D0-probecrash.log`.
- `dcs.20260730-022117.crash` (and its `.dmp`) — deliberate reproduction. Sim
  and bridge logs archived as `c19-run1-CRASH-getMissionLoaded-dcs.log` and
  `c19-run1-CRASH-getMissionLoaded-gui.log`.

A clean control run, same build and same mission, with the getter blocked and
everything else exercised, is archived as `c19-verify-{dcs,gui}.log` — no
`.crash`/`.dmp` produced.

## What we did in the meantime

DCS Studio replaces the `DCS` table that user chunks see with a snapshot whose
`getMissionLoaded` raises an ordinary Lua error naming the crash and pointing at
`getMissionName()` / `getModelTime()` instead
(`bridge/crates/bridge-core/lua/rt.lua`). It is a guard for our users only —
every other tool with a Lua console is still exposed, which is why this belongs
upstream.

## Suggested fix

Terminate the `ED_lua_copyindex` walk: a visited-set (or a depth bound) in the
cross-state value copy would turn a process kill into, at worst, a partial or
refused copy. Whatever `getMissionLoaded` returns in the mission-loaded case
appears to be cyclic or unbounded where the other twenty getters' values are
not; a boolean-returning getter arguably should not be copying a graph at all.
