# Decisions

One record per architectural decision, numbered in the order they were taken.
Records are **append-only and never renumbered**: a decision that stops being
true gets a new record that supersedes it, and the old one stays as history with
its status changed. See [decision 06](06-adopt-repodoc.md) for the convention and
[docs/02-guides/02-planning-with-repodoc.md](../docs/02-guides/02-planning-with-repodoc.md)
for how these fit alongside the board.

Every record carries the same two frontmatter keys — `status` and `date` — where
`date` is when the decision was taken. Anything else about how a record reached
its status belongs in its Consequences, not in a bespoke key.

## Index

| # | Decision | Status | Date | Relations | In one line |
|---|---|---|---|---|---|
| 01 | [GitHub is the whole backend](01-github-as-the-whole-backend.md) | Accepted | 2026-07-13 | — | No registry, no server, no accounts: GitHub releases and topics are the catalog and the source of truth. |
| 02 | [A hexagonal core with an automatically checked boundary](02-hexagonal-core-with-a-checked-boundary.md) | Accepted | 2026-07-25 | — | The rules live in a `vscode`-free core behind ports, and a boundary test fails the build rather than a reviewer noticing. |
| 03 | [Install mods as links, tracked in a JSON ledger](03-install-mods-as-links-not-copies.md) | Accepted | 2026-07-14 | — | Junctions/hardlinks instead of copies, with a ledger, so disable and uninstall are exact rather than a guess. |
| 04 | [Two in-process bridges, speaking JSON-RPC over localhost](04-two-in-process-bridges-over-json-rpc.md) | Accepted | 2026-07-14 | amended by [08](08-lua-state-owns-its-resources.md) | DCS's two Lua states are not interchangeable, so there are two bridges, each serving JSON-RPC on its own port. |
| 05 | [Four test layers with disjoint include sets, each gated at 100%](05-four-disjoint-test-layers-each-at-100.md) | Accepted | 2026-07-26 | — | Unit, integration, e2e and Rust each gate their own non-overlapping include set, so no layer can mask another's gap. |
| 06 | [Adopt RepoDoc for planning and documentation](06-adopt-repodoc.md) | Accepted | 2026-07-29 | — | Planning state moves into the repo — board, decisions, docs — because a closed PR is not a tracker. |
| 07 | [No Lua coverage gate on the number we can currently measure](07-no-lua-coverage-gate-yet.md) | Accepted | 2026-07-29 | — | Only 5 harness states are instrumentable without the `unsafe_new()` trade-off, so a gate over that number would inform nobody; #66 stays open. |
| 08 | [Resources created for a Lua state are owned by that state](08-lua-state-owns-its-resources.md) | Accepted | 2026-07-30 | amends [04](04-two-in-process-bridges-over-json-rpc.md) | Create in the Lua call, return as mlua userdata, let GC drive shutdown — never a DLL loader with process statics. |
| 09 | [Delegated review](09-delegated-review.md) | Accepted | 2026-07-30 | — | Review sign-off is delegated but never to the implementer: a separate review with audits and gates as evidence precedes every `review → done`. |
