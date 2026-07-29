---
column: todo
labels: [ci, process]
priority: high
updatedAt: 2026-07-29T05:22:16.000Z
---
# Protect `main`, and give feature branches CI

`main` is currently enforced by nothing.
[Issue #68](https://github.com/flying-dice/dcs-studio/issues/68) records four
pushes in one hour with **zero check-runs on all four** (`8059b9a`, `5f7122b`,
`d734646`, `bc927a8`), with three issues closed against them.

The structural cause is in `.github/workflows/ci.yml:4-8`: the `push` trigger
lists only `main` and `develop`, so a feature-branch push runs no CI at all. The
gate is the pull request, and "raise the PR first" is a convention the next
session has no structural reason to follow.

#68's recommendation: require the six CI checks and one approving review on
`main`, applied to admins. Neither the authoring session nor the reviewer could
read the current protection config (`403 Resource not accessible by
integration`), so some of it may already be set — check before changing.

## Checklist

- [ ] Read the current branch-protection config on `main`
- [ ] Require the six CI checks (`static`, `unit`, `integration`, `e2e`, `rust`, `windows`)
- [ ] Require one approving review, applied to admins
- [ ] Decide whether `ci.yml` should also fire on `push` to any branch
