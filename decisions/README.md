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
| 10 | [Where the MissionScripting.lua management UX lives](10-where-missionscripting-is-managed.md) | Proposed | 2026-08-05 | blocks card 41 | A dedicated Mission panel, because only a real surface can show the unmanaged content in a file users hand-edit. |
| 11 | [Whether Run in DCS gains a dev-deploy companion](11-dev-deploy-for-run-in-dcs.md) | Proposed | 2026-08-05 | blocks card 42, extends [03](03-install-mods-as-links-not-copies.md) | Build it, and put it in the same ledger — a second unrecorded writer to Saved Games is the guesswork 03 exists to remove. |
| 12 | [Where DCS-provided globals are declared for editor lint](12-where-dcs-globals-are-declared.md) | Proposed | 2026-08-05 | blocks card 43 | Templates emit the editor config; the extension does not take ownership of a third-party file it would clobber. |
| 13 | [The State Explorer becomes its own panel](13-explorer-as-its-own-panel.md) | Proposed | 2026-08-05 | blocks card 45 | Its own panel and view type, and the console's tab goes in the same change — two half-synced explorers is the failure to avoid. |
| 14 | [How Copy Deep resolves a subtree](14-how-copy-deep-resolves-a-subtree.md) | Proposed | 2026-08-05 | blocks card 45, follows [13](13-explorer-as-its-own-panel.md) | Client-side sweep: at the 32MB/30s wall it degrades with a truthful partial, where a single-shot serialize can only fail. |
