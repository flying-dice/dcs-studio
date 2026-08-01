---
column: blocked
labels: [ci, process]
priority: high
agent: claude
live: false
status: blocked — the ONLY remaining step is one command the harness's permission layer refuses to run for an agent; payload ready, see the journal
updatedAt: 2026-08-01T12:10:00.000Z
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
- [x] Decide whether `ci.yml` should also fire on `push` to any branch — done via card 15

## Comments

- **claude** (2026-07-29T05:52:00.000Z): Blocked, and it is a capability limit rather than a judgement call. Branch protection is settable only through the repo-administration API, and there is no branch-protection operation in the GitHub tool surface available to this session at all — not a permissions failure, the operation does not exist here. That matches what #68 already recorded independently: `GET /repos/.../branches/main/protection` returned `403 Resource not accessible by integration` for both the authoring session and the reviewer. **This one needs a human in the repo settings UI.** The recommendation in the card body is unchanged and ready to apply.
- **claude** (2026-07-29T05:52:00.000Z): The second half is not blocked and is worth separating: whether `.github/workflows/ci.yml:4-8` should also fire on `push` to any branch is a repo change, not a settings change, and could be done here. I have deliberately not done it — it is a real trade-off (every feature-branch push would run the full six-job matrix, including a Windows runner and two Rust builds), and #68's recommendation was branch protection rather than a wider push trigger. Raise it as its own card if you want the CI-on-every-branch behaviour independently of protection.
- **claude** (2026-07-29T07:05:00.000Z): The second half described above is no longer only a suggestion — it is card 15-ci-on-feature-branches, in `todo`, with the trade-off laid out (full matrix vs reduced set vs relying on this card's protection). The two cards interact: if protection lands here first, card 15's pressure drops to process rather than protection. This card itself remains blocked on a repo admin.
- **sonnet-ci** (2026-07-29T08:00:00.000Z): Card 15's CI half has landed — `.github/workflows/ci.yml:3-11` now triggers `push` on every branch (`branches: ["**"]`), with `static` and `unit` (`.github/workflows/ci.yml:38-77`) running on all of them and `integration`/`e2e`/`rust`/`windows` (`.github/workflows/ci.yml:94,113,145,194`) gated to `pull_request`, `workflow_dispatch`/`workflow_call`, and `push` only when the ref is `main` or `develop`. That closes the zero-check-run half of #68 §4 structurally: every push now gets at least `static`+`unit`, so "commits pushed, issues closed, zero check-runs" (`8059b9a`, `5f7122b`, `d734646`, `bc927a8`) can no longer happen the same way. What remains on THIS card is protection only — checkbox 4 here is done via card 15, checkboxes 1-3 (read current protection config, require the six checks, require one approving review applied to admins) still need a repo admin in the GitHub UI. Card 15 is in `review`.
- **claude-lead** (2026-08-01T12:10:00.000Z): Close-down attempt under the owner's full delegated authority. The GitHub capability wall is GONE — gh is authenticated as the owner with admin:true — but the Claude Code permission classifier refused the branch-protection PUT twice, and working around a permission layer is off-limits even under a mandate. The deviation from #68's review requirement is deliberate: one human on the repo means required PR review deadlocks the only workflow; required status checks + strict + enforce_admins close the zero-check-run incident #68 SS4 recorded. Run the one command below as yourself and this card is done.

## Ready-to-run payload (protection.json)

Run: `gh api -X PUT repos/flying-dice/dcs-studio/branches/main/protection --input protection.json`

```json
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Compile + lint", "Unit layer (100% gate)", "Integration layer (100% gate)", "E2E layer (100% gate)", "Rust bridge tests (100% gate)", "Shipping target (Windows)"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
```
