---
column: backlog
labels: [docs, process]
priority: low
updatedAt: 2026-07-29T05:22:16.000Z
---
# Correct the wrong `openrpc_meta_schema` bullet on PR #15

[Issue #68](https://github.com/flying-dice/dcs-studio/issues/68) §1, last item.

Comment `5081044418` on the merged PR #15 has a factually wrong
`openrpc_meta_schema` bullet: it wrote up a `cargo llvm-cov` collision as a test
flake before the mechanism was found. Replacement text is ready in
[comment 5081942799](https://github.com/flying-dice/dcs-studio/pull/15#issuecomment-5081942799).

Neither the authoring session nor the reviewer could edit it — no MCP
comment-update op, REST returns `403`, and the reviewer has none of `admin`,
`maintain`, `push` or `triage`. So this needs a human with write access.

Cosmetic: the correct rule is durable in `ARCHITECTURE.md:133-147` ("never run
two `cargo llvm-cov` invocations at once"). Worth doing only because #15's
description points readers at that comment as where the operational context
lives.
