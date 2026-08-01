---
column: review
labels: [bug, bridge]
priority: low
agent: claude-wave3
live: false
updatedAt: 2026-08-01T22:20:00.000Z
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

- [x] Re-init appends (or rotates once) within a process; first init per process may truncate
      — it appends ALWAYS, and the card's parenthesis turned out to be the trap
- [x] Off-sim test: two bootstraps in one process, first bootstrap's lines survive
- [ ] Live confirm across a two-mission session — queued for a future live session

## Comments

- **claude-wave3** (2026-08-01T22:20:00.000Z): **The card's premise needed one
  correction before the fix could be right.** `logging.rs` already had a `Once`
  guarding exactly the "truncate once per process" shape the card proposed — and
  the log truncated anyway, which is the fact that has to be explained before
  anything is changed. The explanation: the mission Lua state CLOSES on unload,
  which drops Lua's `loadlib` handle and unloads the DLL image, so mission 2 gets
  a fresh image with a fresh `Once`, a fresh `log`-crate logger slot, and a fresh
  truncation. A per-process guard can never hold that, because there is no single
  process-lifetime for the mission DLL's statics. So "first init per process may
  truncate" was the option to reject, not implement.

- **claude-wave3** (2026-08-01T22:20:00.000Z): Implemented as **append always,
  bounded by a single roll**: `FileAppender { append: false }` became a
  `RollingFileAppender { append: true }` over a `CompoundPolicy` of a
  `SizeTrigger` at 8 MiB and a `FixedWindowRoller` of exactly one generation
  (`bridge/crates/bridge-core/src/logging.rs:89-102`, constants at `:54` and
  `:59`). Both halves are log4rs's own machinery, which is what made this the
  clean choice: no bespoke rename-before-open, nothing to get wrong on a
  half-written file, and the roll is a rename the appender already knows how to
  do. The result is at most `<name>.log` + `<name>.log.1` per DLL, forever —
  which is a STRICTER bound than the old behaviour ever gave, since
  truncate-on-load bounded nothing within a single mission and a session at
  `trace` could grow the file without limit. Nothing became load-bearing (card
  20): `init` still returns its failure as a string, `bootstrap` logs it and
  serves regardless, and the three failure modes keep their single stringify
  point.

- **claude-wave3** (2026-08-01T22:20:00.000Z): The consequence worth naming: runs
  are now delimited by their timestamps rather than by the file starting over, and
  a DCS restart appends to the previous run's tail. That is the point of the card
  — the previous run is the one you want to read — and it is recorded in the module
  header (`logging.rs:1-32`) so nobody "fixes" the missing truncation later.

- **claude-wave3** (2026-08-01T22:20:00.000Z): Tests, both driving the real
  appender rather than the once-per-process install (which is why the existing
  `repeat_init_is_a_no_op` test could never have caught this — a second `init` in
  one process is a no-op by design, so the card's literal "two bootstraps in one
  process" passes either way; building the appender twice over one path is the
  faithful model of the reload). `a_rebuilt_appender_keeps_what_the_previous_one_wrote`
  (`logging.rs:166-197`) writes mission 1's line, rebuilds, writes mission 2's,
  and asserts both are in the file — it fails with `append(false)`, verified.
  `growth_is_bounded_by_a_single_roll_rather_than_by_truncation` (`:199-243`)
  seeds the file one byte past the trigger, writes two lines, and pins that
  `<name>.log.1` holds the old content plus the tipping line while the live file
  carries on fresh and small. (log4rs writes the record and THEN consults the
  trigger, so the tipping line lands in the outgoing file — the right way round,
  and now documented in the test.) `logging::init`/`try_init`/`build_and_install`
  moved from `PathBuf` to `&Path` on the way through, which clippy required once
  the path stopped being consumed.

- **claude-wave3** (2026-08-01T22:20:00.000Z): Also corrected the machine-facts
  table in `.claude/skills/dcs-dev/SKILL.md:27`, which told the next agent the
  bridge logs are "truncated on first load". Live confirmation across a
  two-mission session is still owed and is queued for the next live run — it
  pairs naturally with card 31's, which needs a surviving mission log to read.
