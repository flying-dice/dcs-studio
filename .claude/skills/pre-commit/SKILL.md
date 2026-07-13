---
name: pre-commit
description: Use before every git push — mandatory quality gate, no exceptions
---

Before push. No exceptions.

1. **Run `change-review`** on the outgoing change — correctness, unhappy paths, tests. Any `bug`/`issue` → blocked. Fix it.
2. **Run `clean-code-review`** on the same change — SRP/DRY/naming/coupling/dead-code/KISS. It tags violations as `// TODO: clean-code - <score> - <CAT>: …` markers.
3. Scan for `// TODO: clean-code -` markers. Score **> 0.5** → blocked. Fix it (or run `refactor` to clear the highest-scored one at a time).
4. Lint, typecheck, tests after every fix.
5. Re-run from step 1. Repeat until `change-review` is clean **and** no `> 0.5` marker remains.

Only then push.