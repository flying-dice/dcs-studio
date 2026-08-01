---
column: todo
labels: [bug, bridge]
priority: low
updatedAt: 2026-08-01T20:40:00.000Z
---
# dcs_studio_mission.log truncates per mission, destroying the previous mission's diagnostics

Found by card 30's live session: the mission bridge's log file truncated on
mission 2's boot (19,812 → 6,899 bytes observed live). Each mission's
`require` re-initializes the per-DLL logger, and the appender truncates. The
cost lands exactly when the log matters most: a post-mortem of mission N's
unload reads a file that mission N+1's boot already destroyed. The teardown
diagnostic line (the card-18 chain's only in-log witness) is among the losses.

Fix direction: append rather than truncate on re-init within one process
(truncate once per process is fine — the GUI log's behaviour), or roll to
`dcs_studio_mission.log.1` before truncating. Mind the card-16/20 history:
logging touches must never become load-bearing for serving, and the file must
not grow unboundedly across a long multi-mission session (a size cap or single
rotation satisfies both).

## Checklist

- [ ] Re-init appends (or rotates once) within a process; first init per process may truncate
- [ ] Off-sim test: two bootstraps in one process, first bootstrap's lines survive
- [ ] Live confirm across a two-mission session
