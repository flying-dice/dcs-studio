---
column: done
labels: [extension, bridge]
priority: med
agent: claude-lead
live: false
updatedAt: 2026-08-02T18:05:00.000Z
---
# Bridge liveness in the status bar: the stalled state

Retro-card for the wave-3 change (merged to develop as "the status bar tells
listening from alive") — the resolution of cards 04 and 17's shared lesson
that a healthy listener is not evidence anything can be dispatched.

Three design decisions, journalled so they stay decisions:

- **Source**: the fourth `CombinedState` "stalled" is classified from replies
  the client already receives — `-32002` → stalled, any sim-produced reply →
  serving, `-32001` → no claim (a teardown answer must not paint a dying
  bridge green). `/health` polling was rejected: a second transport, cadence,
  and source of truth free to disagree with what the calls see.
- **Copy**: `DCS: sim idle` — a held breakpoint, a briefing screen and a
  paused sim all land here and cannot be told apart, so the text claims only
  their common truth. The stale sim clock is dropped from the text (card 04's
  predicted symptom was precisely a frozen number looking live).
- **Cadence**: ping 2s → 10s while stalled, restored instantly by any served
  reply; F5/mission commands pass through to the bridge's own truthful
  refusal rather than duplicating it client-side (pinned by test).

## Checklist

- [x] Classification, precedence (offline > stalled > mission > menu, either bridge suffices), backoff, recovery — unit + integration pinned
- [x] Live confirm (rides the next sim session): hold a breakpoint and sit on a briefing screen — status bar reads "DCS: sim idle", recovers within one served call. Confirmed in DCS 2026-08-02 for all three stall shapes. **The "~2s" is the one number that did not survive contact** — see the journal; the copy, the classification, the precedence and the backoff all did

## Comments

- **claude-lead** (2026-08-01T23:30:00.000Z): Reviewed and approved (delegated review authority) at merge. Design read in full; the -32001 no-claim rule and the copy honesty are the load-bearing choices. Gates green (unit 1429, integration 913, e2e 266, all 100%). Card sits in done with the single live item explicitly outstanding — it joins the next live session's checklist rather than holding the card open.

- **claude-livetrio** (2026-08-02T18:05:00.000Z): **LIVE CONFIRMED — PASS on the state, the copy and the backoff; the latency claim needs restating.** First, a setup note that nearly cost the session its meaning: the VS Code instance on this box runs the *installed* `flying-dice.dcs-studio-0.16.0` from 2026-07-14, which predates wave 3 and knows nothing about `stalled` — it sat there reading `DCS: mission 158s` through a held breakpoint, which is precisely the card-04 symptom this work removes. So the confirmation was run against a compiled Extension Development Host of the tree (`npm run compile`, `code --extensionDevelopmentPath`), and the two windows side by side are the before/after: old build frozen on a stale clock, develop build reading `DCS: sim idle`. Anyone repeating this must check which build they are photographing.

  All three stall shapes reach the state, with the copy exactly as designed
  (`src/core/domain/bridgeStatusView.ts:38-44`) — `$(debug-pause) DCS: sim idle`,
  no clock:

  | shape | reached `DCS: sim idle` | recovered |
  |---|---|---|
  | briefing screen (mission 1, and again mission 2) | yes, held for the whole screen | `DCS: mission 0s` on FLY |
  | held mission breakpoint | yes | `DCS: mission 248s`, +3.25–3.52 s after `debug_continue` |
  | ESC pause menu (twice) | yes | `DCS: mission 446→448s`, +6.39–7.69 s after resume |

  Recovery is inside one served call in every case, which is the claim that
  mattered: the stalled cadence is 10 s and both recoveries landed under it.
  The dropped clock earned itself too — during the ESC hold the old build's bar
  read `DCS: mission 301s` while the sim was frozen, and the develop build
  refused to say a number at all.

- **claude-livetrio** (2026-08-02T18:05:00.000Z): **The backoff is confirmed, and cleanly, because the old extension turned out to be a control.** Both builds were talking to the same bridges, so `dcs_studio_mission.log` / `dcs_studio_gui.log` carry two interleaved refusal series distinguishable by their JSON-RPC ids. Over one 30 s held breakpoint in `dcs_studio_gui.log`:

  - old build (2 s, no backoff): `17:44:59.738, 17:45:01.740, …:03.752, …:05.761,
    …:07.763` — every 2.0 s for the whole stall, 30 pings.
  - develop build: `17:45:02.025, :12.030, :22.032, :32.049, :42.053, :52.069` —
    **10.00 s apart, six pings**, ids consecutive (`162, 163, 164 …`), so it made
    no other request on either bridge in between.

  That is `PING_STALLED_INTERVAL_MS` doing exactly what
  `src/core/domain/bridgeProtocol.ts:109-127` says, measured against a build that
  does not have it: a 5× reduction in refused traffic, and the "card 17 watched
  `deadline has elapsed` every two seconds" noise is now the old build's line in
  the log, not ours. The same 10 s series appears in `dcs_studio_mission.log`
  across two independent ESC holds (`[162,163,164]`, `[227,228]`), so it is not
  a one-off.

- **claude-livetrio** (2026-08-02T18:05:00.000Z): **The one thing that did not hold: "within ~2s". Measured detection was 2.3 s once and ~6.7 s twice, and the mechanism is worth writing down because it is not the backoff's fault.** Timings, taking stall onset from the bridge's own `has not been drained for Ns` arithmetic rather than from my keypress:

  - held breakpoint — sim stopped serving 17:44:59.74, bar flipped between
    +5.53 s and +6.46 s of dispatch = **2.3 s after onset**. Matches the claim.
  - ESC pause #1 — onset 17:49:44.58, first refused develop ping 17:49:52.20 =
    **+7.6 s**.
  - ESC pause #2 — onset 17:52:29.44, bar flipped between +6.47 s and +7.10 s,
    first refused develop ping 17:52:36.15 = **+6.7 s**.

  The cause is a three-part latency the design did not account for, and the
  backoff is only the last third of it. The bridge does not refuse immediately:
  it queues, and only starts answering `-32002` once the pump has been idle
  about 2 s (the first refusal of every stall reads `…for 2.0–2.4s`). A ping
  that lands inside that window is therefore *queued, not refused* — it carries
  no evidence either way. The client then waits `PING_TIMEOUT_MS` (4 s) and, by
  the deliberate design at `src/bridge/client.ts:362-365`, **ignores a lone ping
  timeout**, so the state does not change; the next ping goes out 2 s later and
  is the first one actually refused. Worst case 2 + 4 + 2 ≈ 8 s, best case ~2 s
  when the ping happens to land after the threshold — which is exactly the
  spread observed. The queued pings are visible dying on the other side:
  `[ERROR] … deadline has elapsed` at 17:50:15.60, :16.20, :16.58 — the 30 s
  server deadline expiring on requests queued at ~17:49:45.

  Nothing here is broken and the states are all truthful — but the card says
  "~2s" and the measurement says "2–8 s, depending where the ping falls". Two
  options for the lead, neither taken here: correct the copy in the card and in
  `pingIntervalFor`'s doc comment to state the real bound, or treat a ping
  timeout against a *connected* bridge as weak stall evidence, which would pull
  the worst case to ~6 s at the cost of the "a lone timeout is ignored" rule
  that exists for reasons of its own. My read is that the first is right and the
  second is not worth it: the state is truthful either way, and the design's own
  argument — that 10 s of a truthful "sim idle" beats 2 s of pings into a queue
  that cannot drain — applies just as well to 8 s of a truthful "mission" before
  it.
