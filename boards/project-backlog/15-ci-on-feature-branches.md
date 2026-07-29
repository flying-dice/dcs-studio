---
column: todo
labels: [ci, process]
priority: med
updatedAt: 2026-07-29T07:05:00.000Z
---
# Decide whether ci.yml should fire on pushes to any branch

Split out of card 02, where it was noted as doable-but-not-done. Card 02's
branch-protection half needs a repo admin; this half is a workflow-file change
anyone can make — but it is a genuine trade-off, not an oversight, which is why
it was not folded into the burn-down.

Today `.github/workflows/ci.yml:4-8` triggers on `push` only for `main` and
`develop`, so a feature-branch push runs no CI at all. The gate is the pull
request. #68 §4 records the failure mode: four commits pushed and three issues
closed against them with zero check-runs, because no PR existed yet.

The trade-off to weigh:

- **For widening the trigger:** work is validated as it is pushed, not only
  once a PR exists. The #68 incident becomes structurally impossible instead of
  procedurally discouraged.
- **Against:** every feature-branch push runs the full six-job matrix — a
  Windows runner and two Rust builds included — even for work-in-progress
  pushes nobody intends to merge yet. The existing `concurrency` block cancels
  superseded PR runs, but branch pushes without a PR would each run to
  completion.
- **Middle paths worth considering:** trigger on `push: branches: ["**"]` but
  with a reduced job set (static + unit only) for non-PR branches, or keep the
  current shape and rely on branch protection (card 02) to make the PR gate
  unskippable.

If branch protection lands first, the pressure here drops — an unreviewed push
to `main` stops being possible, and the residual risk is only "issues closed
against unchecked feature commits", which is process rather than protection.

## Checklist

- [ ] Decide the trigger shape (full matrix / reduced set / rely on card 02)
- [ ] Apply it to `.github/workflows/ci.yml` with the reasoning in a comment
- [ ] Note the outcome on card 02
