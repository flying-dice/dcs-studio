---
column: blocked
labels: [ci, process]
priority: high
agent: claude
live: false
status: blocked — needs repo admin, no API available to an agent
updatedAt: 2026-07-29T05:52:00.000Z
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

## Comments

- **claude** (2026-07-29T05:52:00.000Z): Blocked, and it is a capability limit rather than a judgement call. Branch protection is settable only through the repo-administration API, and there is no branch-protection operation in the GitHub tool surface available to this session at all — not a permissions failure, the operation does not exist here. That matches what #68 already recorded independently: `GET /repos/.../branches/main/protection` returned `403 Resource not accessible by integration` for both the authoring session and the reviewer. **This one needs a human in the repo settings UI.** The recommendation in the card body is unchanged and ready to apply.
- **claude** (2026-07-29T05:52:00.000Z): The second half is not blocked and is worth separating: whether `.github/workflows/ci.yml:4-8` should also fire on `push` to any branch is a repo change, not a settings change, and could be done here. I have deliberately not done it — it is a real trade-off (every feature-branch push would run the full six-job matrix, including a Windows runner and two Rust builds), and #68's recommendation was branch protection rather than a wider push trigger. Raise it as its own card if you want the CI-on-every-branch behaviour independently of protection.
