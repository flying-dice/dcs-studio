---
column: backlog
labels: [process]
priority: med
updatedAt: 2026-07-29T05:22:16.000Z
---
# Close out the testing-pyramid handover (#68)

[Issue #68](https://github.com/flying-dice/dcs-studio/issues/68) is the handover
from the sessions that produced #15 (merged) and #67 (open). Its own closing
condition: **close it once #67 is merged and the "Needs a decision" items are
either done or re-homed.**

Cards 01, 02, 05 and 11 are those items, now re-homed onto this board. This card
is the last step — check them off against the issue and close it.

Two process notes in #68 §4 are worth keeping rather than losing with the issue:

- CI does not run on feature branches; the gate is the pull request, not the
  push. Card 02 makes that structural.
- Never run two `cargo llvm-cov` invocations at once — they share
  `bridge/target/llvm-cov-target` and the second's rebuild deletes the first's
  test binaries. Already durable in `ARCHITECTURE.md:143-147`.

Also worth carrying forward: #68 §5 states that review coverage on #15 was
partial — roughly 40 `src/` files, most of `test/`, `previews/` and `media/*.css`
were never read. Absence of a finding there is not evidence of absence.

## Checklist

- [ ] Card 01 (#67 merged)
- [ ] Card 02 (branch protection)
- [ ] Card 05 (#66 route chosen)
- [ ] Card 11 (comment corrected)
- [ ] Close #68
