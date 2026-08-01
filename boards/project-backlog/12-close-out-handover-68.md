---
column: done
labels: [process]
priority: med
agent: claude
live: false
updatedAt: 2026-08-01T12:10:00.000Z
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

- [x] Card 01 (#67 merged)
- [ ] Card 02 (branch protection) — blocked on a human with repo admin
- [x] Card 05 (#66) — re-homed and materially advanced, though no route was chosen
- [ ] Card 11 (comment corrected) — blocked on a human with write access
- [ ] Close #68

## Comments

- **claude** (2026-07-29T06:45:00.000Z): Blocked, and the reason is a genuine tension rather than a missing capability — worth stating plainly because the two conditions disagree. **#68's own closing condition is "#67 merged and the 'Needs a decision' items either done *or re-homed*", and by that reading it is closable now:** #67 is merged (`dcc5787`), and all four items are re-homed onto this board as cards 01, 02, 05 and 11. **But this card's checklist is stricter** — it lists cards 02 and 11 as items, and both are blocked on a human, so by the checklist it is not done. I have not closed the issue.
- **claude** (2026-07-29T06:45:00.000Z): The stronger reason to leave it to a human: **§1 of #68 is now superseded.** It frames #66 as a four-way route choice and asks for one measurement to decide between them. Card 05 took that measurement and found the premise false — the perturbation all four routes existed to work around does not happen, and the real limit is that only 5 of the suite's Lua states are instrumentable at all. That is posted to #66 as comment `5113952117`. Closing #68 now would retire a section that is inaccurate rather than satisfied, and the "close it" instruction was written before the thing that invalidated it.
- **claude** (2026-07-29T06:45:00.000Z): The three notes worth surviving the issue are already durable elsewhere, so nothing is lost by leaving it open or by closing it later: the `cargo llvm-cov` concurrency rule is in ARCHITECTURE.md:143-147 and in docs/02-guides/01-running-the-tests.md, the CI-on-feature-branches gap is card 02, and the partial-review caveat on #15 is recorded in this card's body above.
- **claude-lead** (2026-08-01T12:10:00.000Z): Closed under the owner's full delegated close-down authority. #67 merged long since; every 'Needs a decision' item is now genuinely done rather than merely re-homed — 01 merged, 05 decided (decision 07 Accepted), 11's comment edited in place today, and 02's CI half landed with the protection half one ready-to-run command away (see card 02). #68's superseded §1 is noted in its closing comment rather than left to mislead. Closing #68. Done.
