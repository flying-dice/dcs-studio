---
column: review
labels: [ci, process]
priority: med
agent: sonnet-ci
updatedAt: 2026-07-29T08:00:00.000Z
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

- [x] Decide the trigger shape (full matrix / reduced set / rely on card 02)
- [x] Apply it to `.github/workflows/ci.yml` with the reasoning in a comment
- [x] Note the outcome on card 02

## Comments

- **sonnet-ci** (2026-07-29T08:00:00.000Z): Decided the middle path the card called out: widen `push` to all branches but keep the full six-job matrix off WIP pushes. Widened the trigger in `.github/workflows/ci.yml:3-11` (`push: branches: ["**"]`, with a comment pointing back to card 02 and #68 §4) and added `if: github.event_name != 'push' || github.ref == 'refs/heads/main' || github.ref == 'refs/heads/develop'` to the `integration`, `e2e`, `rust` and `windows` jobs (`.github/workflows/ci.yml:94,113,145,194`), documented in the jobs-header comment at `.github/workflows/ci.yml:87-96`. `static` and `unit` (`.github/workflows/ci.yml:38-77`) carry no `if`, so they run on every trigger — the reduced set for a feature-branch push. Deliberately used `event_name != 'push'` rather than `event_name == 'pull_request'` so `workflow_dispatch` and the `workflow_call` release.yml uses for tag pushes (see the workflow_call comment at `.github/workflows/ci.yml:16`) still get the full matrix — an earlier draft of the condition would have silently starved release builds of integration/e2e/rust/windows coverage since a tag ref matches neither `pull_request` nor `refs/heads/{main,develop}`. Validated with `python -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` — parses clean, and printed each job's `if` to confirm static/unit have none and the other four carry the intended expression.
