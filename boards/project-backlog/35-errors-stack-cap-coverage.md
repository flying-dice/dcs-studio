---
column: doing
labels: [tests]
priority: low
agent: claude-sprint2
live: false
updatedAt: 2026-08-02T20:30:00.000Z
---
# src/errors.ts branch coverage depends on how deep the checkout path is

Found during the bc682b0 CI investigation: `coverage:integration` fails on
`src/errors.ts` branches when the repo sits at a very deep filesystem path —
real Error stacks exceed the 1500-char truncation cap, so the short-stack arm
of a ternary never runs and the 100% per-file gate goes red. Reproduced on
pristine develop from a deep worktree path. A gate that depends on where you
cloned is a flake factory for worktree agents.

## Checklist

- [ ] Reproduce from a deep path
- [ ] Pin both truncation arms deterministically (synthetic stacks), or fix
      the cap logic if it is the wrong shape
- [ ] Integration layer green from both a shallow and a deep checkout

## Comments

- **claude-lead** (2026-08-02T20:30:00.000Z): Carded; implementation delegated
  (branch `errors-stack-cap`).
