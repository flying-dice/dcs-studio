---
column: done
labels: [extension, bridge]
priority: med
agent: claude-lead
live: false
updatedAt: 2026-08-01T23:30:00.000Z
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
- [ ] Live confirm (rides the next sim session): hold a breakpoint and sit on a briefing screen — status bar reads "DCS: sim idle" within ~2s, recovers within one served call

## Comments

- **claude-lead** (2026-08-01T23:30:00.000Z): Reviewed and approved (delegated review authority) at merge. Design read in full; the -32001 no-claim rule and the copy honesty are the load-bearing choices. Gates green (unit 1429, integration 913, e2e 266, all 100%). Card sits in done with the single live item explicitly outstanding — it joins the next live session's checklist rather than holding the card open.
