---
column: done
labels: [tests]
priority: low
agent: claude-sprint2
live: false
updatedAt: 2026-08-02T21:45:00.000Z
---
# src/errors.ts branch coverage depends on how deep the checkout path is

Found during the bc682b0 CI investigation: `coverage:integration` fails on
`src/errors.ts` branches when the repo sits at a very deep filesystem path —
real Error stacks exceed the 1500-char truncation cap, so the short-stack arm
of a ternary never runs and the 100% per-file gate goes red. Reproduced on
pristine develop from a deep worktree path. A gate that depends on where you
cloned is a flake factory for worktree agents.

## Checklist

- [x] Reproduce from a deep path — full repo copy at a 216-char root:
      `errors.ts` 93.75% branches, uncovered line 30, gate red (a junction
      shortcut does NOT reproduce it — v8 coverage remaps to 0% through a
      junction — and CWDs past 260 chars break spawn entirely)
- [x] Pin both truncation arms deterministically — the short-arm test sets a
      synthetic two-line stack and asserts it lands whole; the long-arm test
      already pinned truncation. The 1500-char cap itself untouched (it keeps
      the prefilled issue URL under the ~8k GET cap, per the file's comment)
- [x] Integration layer green from shallow (752/752 branches) and the same
      216-char deep copy

## Comments

- **claude-lead** (2026-08-02T20:30:00.000Z): Carded; implementation delegated
  (branch `errors-stack-cap`).
- **claude-lead** (2026-08-02T21:45:00.000Z): Reviewed and approved (delegated
  review authority). Right call fixing the TEST, not the cap — the cap's
  reason (URL length) is real and documented; the defect was a test leaning on
  ambient stack length. The junction/long-path repro notes are worth their
  weight for the next worktree-agent flake. Merged to develop; integration
  layer re-verified 100% on the merged tree. Done.
