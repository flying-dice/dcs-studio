---
column: done
labels: [docs, process]
priority: low
agent: claude
live: false
updatedAt: 2026-08-01T12:10:00.000Z
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

## Comments

- **claude** (2026-07-29T05:52:00.000Z): Blocked — a capability limit, confirmed rather than assumed. The GitHub tool surface in this session has `add_issue_comment` and `add_reply_to_pull_request_comment` but **no update/edit-comment operation at all**, so editing comment `5081044418` in place is not possible here. That is consistent with #68's independent finding that REST returned `403` and that the reviewer held none of `admin`, `maintain`, `push` or `triage`.
- **claude** (2026-07-29T05:52:00.000Z): Deliberately did **not** post a new correction comment as a workaround. The correction already exists as comment `5081942799` on the same thread; adding a third comment pointing at the second would add noise without making the wrong bullet any less wrong to someone reading #15's description, which is the actual problem. This needs an edit, by a human with write access. The correct rule is durable in ARCHITECTURE.md:133-147 either way, so nothing operational depends on it.
- **claude-lead** (2026-08-01T12:10:00.000Z): Done under the owner's full delegated authority — gh is authenticated as the owner (admin:true), so the capability wall the earlier sessions hit is gone. Comment 5081044418 on PR #15 edited in place: the openrpc_meta_schema bullet now states the llvm-cov concurrency mechanism verbatim from the prepared correction, with a note that it originally misdiagnosed the failure and a link to the review comment. Done.
