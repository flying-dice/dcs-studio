---
column: todo
labels: [bridge, lua, performance, live]
priority: medium
agent: opus-luaperf
live: true
updatedAt: 2026-08-01T00:00:00.000Z
---
# Live re-measure the pause CPU and the line-hook cost

Two changes landed this sprint that are gated headlessly but whose *value* only a
sim can price. Both are behaviour-preserving and already green off-sim; this card
is the measurement, not a fix.

Neither blocks anything. They are carded because the headless tests prove the
mechanism changed, not that the number moved — and shipping a performance claim
that has only ever been measured against PUC liblua5.1 is exactly what issue #65
exists to stop.

## What changed

**The held-pause sleep.** `hold_pause` throttled its RPC drain to 0.05 s but never
yielded between drains, so the loop ran flat out for the whole hold — up to the
full `idle_seconds` (30) while someone reads a breakpoint. It now sleeps 5 ms per
iteration through a new `bridge.debug.sleep_ms` export
(`bridge/crates/bridge-core/src/debug.rs`, `lua/debug_engine.lua`'s `hold_pause`).

**The line-hook fetch split.** The hook fetched `debug.getinfo(2, "nSlf")` on
*every* line of a debugged chunk when only `"S"` is needed on the common path;
`info.func` is used solely by the conditional-breakpoint branch and `info.name`
never. Split so `"S"` is fetched always and `"f"` lazily, inside that branch.

## Why the pause measurement is not a formality

Card 03's live session on 2026-07-29 already measured a held pause at **200 % of
one core against 216 % free-running** — i.e. the hold looked, if anything,
*cheaper* than a running sim. That measurement was taken after the drain throttle
landed and before this sleep did, so it is evidence that the remaining busy-wait
was not the dominant cost in a real DCS process, whatever the code reads like.

So the honest hypothesis for this card is that the sleep changes little in DCS,
and the point of measuring is to find out rather than to confirm. If it does
nothing measurable, that is worth recording against the change.

## Checklist

- [ ] Hold a mission breakpoint for ~20 s and record DCS's process CPU, against a
      free-running baseline taken in the same session — the card-03 method, so the
      numbers are comparable to the 200 %/216 % already on record
- [ ] Confirm resume latency did not regress: the 5 ms sleep bounds how long the
      release can overshoot, so `debug_continue` should still return in tens of ms
      (card 03 measured 48 ms) and the session should end promptly after
- [ ] Time a `debug_run` over a loop-heavy chunk with a breakpoint set but not
      hit, before/after the getinfo split, to price the common-path saving
- [ ] Confirm conditional breakpoints still evaluate correctly in DCS's own state,
      since that is the branch that now fetches `"f"` lazily — a condition
      referencing an upvalue is the case that exercises it

Drive it with the `dcs-dev` skill (`.claude/skills/dcs-dev/SKILL.md`). Card 03's
session notes carry the traps worth knowing (the DPI scaling, the authorization
modal, the briefing gate).
