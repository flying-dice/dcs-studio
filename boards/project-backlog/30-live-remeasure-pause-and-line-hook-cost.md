---
column: review
labels: [bridge, lua, performance, live]
priority: medium
agent: opus-luaperf
live: false
updatedAt: 2026-08-01T14:10:00.000Z
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

- [x] Hold a mission breakpoint for ~20 s and record DCS's process CPU, against a
      free-running baseline taken in the same session — the card-03 method, so the
      numbers are comparable to the 200 %/216 % already on record
- [x] Confirm resume latency did not regress: the 5 ms sleep bounds how long the
      release can overshoot, so `debug_continue` should still return in tens of ms
      (card 03 measured 48 ms) and the session should end promptly after
- [x] Time a `debug_run` over a loop-heavy chunk with a breakpoint set but not
      hit, before/after the getinfo split, to price the common-path saving
      — priced by direct `getinfo` A/B in DCS's own Lua; a true before/after was
      not available (no old build deployed), and that limit is journalled
- [x] Confirm conditional breakpoints still evaluate correctly in DCS's own state,
      since that is the branch that now fetches `"f"` lazily — a condition
      referencing an upvalue is the case that exercises it
      — locals PASS, fail-open PASS; upvalue conditions CANNOT work in DCS
      (`debug.getupvalue` is nil in both states) — pre-existing, not a regression

Drive it with the `dcs-dev` skill (`.claude/skills/dcs-dev/SKILL.md`). Card 03's
session notes carry the traps worth knowing (the DPI scaling, the authorization
modal, the briefing gate).

## Comments

- **opus-luaperf** (2026-08-01T14:05:00.000Z): Claimed the card for the sprint-closing
  live session on branch `sprint-live-close` (off `develop` @ `24e5698`). Deployed the
  develop tree with `bridge/deploy/deploy.ps1` with DCS down — both DLLs + hook rebuilt
  release, deployed hook hash matches `bridge/hook/DcsStudio.lua`. This build carries the
  whole sprint: pause-loop `sleep_ms`, the trimmed line hook, stdlib localisation, queue
  cap 256 + `-32002` queue-full, the 32 MB limits, `Arc`'d `ServiceInfo`, the Teardown
  phase and the NaN clamp fix. DCS launched `--no-launcher` at 14:50:54 local, GUI
  `/health` OK ~2 min later; no authorization modal this boot. Mission: stock
  `A-10A - IA - Caucasus - Free flight` via `DCS.startMission`, briefing FLY clicked at
  DPI-aware (3117,1524).

- **opus-luaperf** (2026-08-01T14:06:00.000Z): **A1/A2 — the held-pause CPU, and the
  sleep is vindicated.** Card-03 method, `Get-Process DCS` `TotalProcessorTime` deltas
  over wall time, as % of one core, both conditions in the same session on the same
  mission:

  | condition | window | % of one core |
  |---|---|---|
  | free-running #1 | 30.0 s @ 14:55:11 | **455.1 %** |
  | held mission breakpoint #1 | 18.0 s @ 14:57:18 | **100.8 %** |
  | free-running #2 | 30.0 s @ 15:00 | **375.9 %** |
  | held mission breakpoint #2 | 18.0 s | **101.2 %** |

  The absolute numbers are much higher than card 03's because this box is doing more
  (editor, agents) — the comparable figure is the **ratio**. Card 03 measured a hold at
  **200 % against 216 % free-running, a ratio of 0.93** — the hold cost essentially as
  much as a running sim. This session measures **0.22 and 0.27**. A held pause now costs
  ~1 core (the parked sim thread plus DCS's own background threads) instead of tracking
  the free-running cost. So the card's own honest hypothesis — that the sleep would
  change little in DCS — **is refuted**: the remaining busy-wait *was* material once the
  drain throttle was in place, and `bridge.debug.sleep_ms` at
  `bridge/crates/bridge-core/lua/debug_engine.lua:715` removed it. Both holds were sized
  to sit inside the 30 s idle auto-continue (a first attempt sampled 22 s from t+15 s and
  caught the auto-release mid-sample at 193.6 % — discarded as contaminated, recorded
  here so the number is not mistaken for a result).

- **opus-luaperf** (2026-08-01T14:07:00.000Z): **A2 — resume latency did NOT regress.**
  `debug_continue` returned in **8.6 ms** (hold #1) and **50 ms** / **53.7 ms** (hold #2,
  mission 2) against card 03's 48 ms; `debug_state` reported `paused:false, running:false`
  immediately after, and the GUI bridge was serving `eval` again **6.6 ms** later with
  model time advancing. Nothing near the ~1 s revert threshold, and the 5 ms sleep budget
  bounds the overshoot as designed. **The sleep stays** — it is a large win on hold cost
  with no measurable resume cost.

- **opus-luaperf** (2026-08-01T14:08:00.000Z): **A3 — the line hook priced.** 200 000-line
  loop chunk, elapsed measured inside Lua on `bridge.debug.monotonic`, 5 reps per
  condition, interleaved:

  | condition | mean | min | max |
  |---|---|---|---|
  | plain `eval`, no debug session (no line hook) | **1.21 ms** | 1.17 | 1.25 |
  | `debug_run`, no breakpoints set | **566.19 ms** | 564.88 | 567.25 |
  | `debug_run`, breakpoint armed in another file (hook armed, never matches) | **570.52 ms** | 566.69 | 574.62 |

  So the line hook costs **~2.83 µs per line** in DCS's mission Lua — a ~470x slowdown
  on hooked chunks — and arming a breakpoint in a *non-matching* source adds only
  **4.3 ms / 200 k lines (~0.02 µs per line, +0.8 %)**, i.e. the source lookup on the
  common path is free relative to the hook itself. A true before/after of the getinfo
  split was not possible (only the post-split build is deployed), so the saving was
  priced directly instead, benchmarking `debug.getinfo` in DCS's own Lua, 100 k calls,
  6 alternating reps, medians: **`"S"` = 1.034 µs/call (min 1.017)** vs
  **`"nSlf"` = 1.521 µs/call (min 1.502)**. The split therefore saves **~0.49 µs on every
  line of every debugged chunk** — 32 % of the getinfo cost and ~17 % of the whole 2.83 µs
  per-line hook budget. That is a real, if unspectacular, common-path win, and it is now
  a measured number rather than a mechanism claim.

- **opus-luaperf** (2026-08-01T14:09:00.000Z): **A3/A4 — conditional breakpoints, and a
  finding worth a card.** Locals work: condition `i == 7` on line 3 paused exactly at
  `i == 7` (`debug_eval` frame 0 → `7`). Fail-open works: a syntactically broken condition
  (`i ==== nope(`) paused and surfaced
  `cond_error: breakpoint condition error: ... '=' expected near '=='`, as
  `debug_engine.lua:785` intends. **But a condition referencing an upvalue never fires** —
  `i == target` and `target == 7 and i == 5` both ran the chunk to completion with no
  pause and no error. The cause is not the lazy `"f"` fetch: **`debug.getupvalue` and
  `debug.setupvalue` are `nil` in BOTH of DCS's Lua states** (verified live — mission and
  GUI: `getinfo`/`getlocal`/`sethook` present, `getupvalue`/`setupvalue` absent), so
  `collect_upvalues` (`debug_engine.lua:264-269`) can never return anything in DCS and the
  proxy env falls through to `_G`, where `target` is `nil` — the condition quietly
  evaluates false. This is **pre-existing host behaviour, not a sprint regression**, and
  the code already anticipates it (`debug_engine.lua:72`, `:639`). Two consequences for
  the lead: (1) the lazy `debug.getinfo(2,"f")` at `debug_engine.lua:775` buys nothing in
  DCS today and could be skipped entirely behind a `debug.getupvalue ~= nil` guard,
  saving a getinfo on every conditional-breakpoint hit; (2) an upvalue condition fails
  *silently* rather than fails *open*, which is the one shape of wrong answer the engine
  otherwise avoids — worth a card of its own.

- **opus-luaperf** (2026-08-01T14:10:00.000Z): **B — sprint smoke, all through the live
  bridges. 7/7 PASS.** (1) Both bridges served at `warn` with the new
  `queue_depth`/`queue_capacity` fields alongside `pump_idle_ms`/`pump_stalled` on
  `/health`, on both ports. (2) `eval` round-trips clean post-localisation: UTF-8 +
  escapes (`"héllo\tworld \"q\" \\ end"`) exact, nested table → `{"a":1,"b":[2,3,"x"],
  "c":true,"d":1.5}`, and the decimal point is `.` not `,` under the host locale
  (`tostring(1.5)`, `string.format("%.3f",3.14159)`, `tonumber("2.5")` all correct);
  `print` capture via `console_read` returned `smoke-print-A\t42` on the GUI bridge and
  `m2-print\t1.5` on the mission bridge. (3) **NaN clamp live**: `sleep_ms(0/0)` returned
  in **2.2 µs** without hanging or killing anything, `sleep_ms(-5)` 0.4 µs, `sleep_ms(0)`
  0.3 µs, `sleep_ms(1e9)` clamped to **1.0003 s**, `sleep_ms(50)` 50.1 ms, `ping` fine
  after. (4) **Card 17 intact under the stdlib-local chunks**: during a held mission
  breakpoint the GUI `/rpc` fast-failed `-32002 sim not pumping` in **6 ms** while GUI
  `/health` reported `pump_stalled:true, pump_idle_ms:18828` and stayed 200. (5)
  **Mission quit → clean unload → rebind, the critical regression check, 2/2**:
  `DCS.stopMission()` twice, DCS survived both, port 25570 closed, and `dcs.log` carries
  the Teardown diagnostic verbatim both times —
  `DCS Studio: mission bridge released 20 Lua handler(s), failed 0 queued request(s) and
  stopped its HTTP server on port 25570 on mission end` (14:02:31.287 and 14:04:34.039) —
  bracketing two `mission bridge serving JSON-RPC on 127.0.0.1:25570` lines. Mission 2
  (`A-10A - Nevada - Free Flight`) rebound fully: mission `eval` (`env.mission.theatre`
  → `Nevada`), a fresh debug session pausing at the right line with `pause_id` back to 1,
  `debug_continue` in 53.7 ms, and a fresh console buffer. (6) Log volume stayed
  `warn`-quiet and **zero `lua_atpanic` and zero Rust panic lines** across
  `dcs.log`, `dcs_studio_gui.log` and `dcs_studio_mission.log`. (7) Queue-cap probe: 400
  GUI `/rpc` requests fired during a held pause **all 400** came back `-32002 sim not
  pumping` and the observed `queue_depth` never exceeded **3** of 256 — the stall guard
  refuses *before* enqueueing, so the queue-full `-32002` path is not reachable via a
  stall and stays a headless-only test. No unbounded growth either way.

- **opus-luaperf** (2026-08-01T14:10:00.000Z): **Teardown and hygiene.** DCS shut down via
  the `DCS.exitProcess()` notification, process gone at 15:05:12 local, no `.dmp`.
  **The deployment is left in place — it is the `develop` build**, deployed hook hash
  `34C78181…D479F0` equals the repo's `bridge/hook/DcsStudio.lua`; DLL hashes
  `7396DBF4…2E854` (gui) / `6C42583C…2CBC3F` (mission). Nothing outside the repo was
  modified: `MissionScripting.lua` hashed
  `F212DF7F2BC6799C2D04B766EF702088C4779661FEE164F76F0426EFA6D80F6D` before and after
  the session (already desanitized on arrival, left exactly as found), and no other
  hook or `Config\` file was touched. Logs archived to the session scratchpad as
  `card30-dcs.log`, `card30-gui.log`, `card30-mission.log`. One incidental observation
  for the lead: `dcs_studio_mission.log` **shrank** across the second mission boot
  (19 812 → 6 899 bytes), so the mission bridge appears to truncate its log per mission
  rather than per process — mission 1's diagnostics are gone once mission 2 starts, which
  will hurt the next time an unload needs post-mortem. Card moved to `review`;
  A and B are both complete.
