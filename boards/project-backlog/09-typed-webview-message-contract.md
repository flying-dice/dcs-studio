---
column: backlog
labels: [webview, tests]
priority: med
updatedAt: 2026-07-29T05:22:16.000Z
---
# Declare the webview ↔ panel message contract as a type

Gap G3 from the testing audit
(`docs/04-quality/01-testing-audit.md:114-127`), and the first entry under "What
is deliberately not done" (`docs/04-quality/01-testing-audit.md:385-389`).

Both halves of every webview protocol now execute under their own gate, so a
dropped handler fails a test — the seam is no longer held together by discipline
alone. What is still missing is a *declared* contract: a typed
`HostMessage`/`WebviewMessage` union shared by the presenter and `media/*.js`,
so one table-driven test can assert every message type the webview emits is
handled and vice versa.

The audit is explicit that the cheap version is the wrong one: deriving the table
by regex produces false failures, because the webviews use several dispatch
shapes. It says this is worth doing **alongside a wider presenter rollout** —
which makes it a natural follow-on to card 08 rather than standalone work.

## Checklist

- [ ] Wait on, or land with, the presenter rollout (card 08)
- [ ] Declare the message unions in `src/core/` where both sides can name them
- [ ] Add the table-driven both-directions test
