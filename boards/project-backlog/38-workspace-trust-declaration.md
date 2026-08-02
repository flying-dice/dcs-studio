---
column: done
labels: [bug, extension]
priority: med
agent: claude-lead
live: false
updatedAt: 2026-08-02T22:30:00.000Z
---
# In Restricted Mode the extension is silently inert — no trust declaration

Found by smoke-testing the packaged vsix in a pristine VS Code profile
(isolated `--user-data-dir`/`--extensions-dir`): with Workspace Trust at its
default, `onStartupFinished` fired for builtins but never for
`flying-dice.dcs-studio` — no status bar, no commands, no error, nothing that
says why. A fresh profile opens every folder in Restricted Mode, so this is
precisely a new user's first experience. Root cause: `package.json` declared no
`capabilities.untrustedWorkspaces`, and VS Code's default for undeclared
extensions is "do not activate, say nothing".

Fix: declare `untrustedWorkspaces: { supported: false }` with a description —
honest, because the extension runs workspace-driven tools (git, gh, 7-Zip,
cargo) and writes into DCS directories. Activation behaviour is unchanged;
what changes is that VS Code now SHOWS the extension as disabled-pending-trust
with our reason, instead of silently dropping it.

Evidence chain: exthost.log with trust on → no activation line; seeding
`"security.workspace.trust.enabled": false` into the profile → 
`_doActivateExtension flying-dice.dcs-studio … onStartupFinished` appears.

## Checklist

- [x] Reproduce in a pristine profile (packaged vsix, not the dev host)
- [x] `capabilities.untrustedWorkspaces` declared with reasoned description
- [x] Gates re-run on the tree

## Comments

- **claude-lead** (2026-08-02T22:30:00.000Z): Found, fixed and signed off by
  the lead directly — a manifest declaration, not logic. The dev host and this
  box never showed it because trust was long since granted here; only a
  first-run profile exposes it. Done.
