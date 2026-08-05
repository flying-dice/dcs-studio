---
status: Proposed
date: 2026-08-05
---
# Decision 14 — How Copy Deep resolves a subtree

## Context

[Issue #77](https://github.com/flying-dice/dcs-studio/issues/77), board card 45.
The explorer tree is lazy, so the per-node copy (`copyNode` in
`media/console-explorer.js`) puts only the **loaded** children on the clipboard —
collapsed and unvisited descendants are simply absent. The only way to capture a
whole subtree today is the full-table JSON export, which is deep but file-shaped
and table-rooted.

"Copy Deep" resolves a node's entire subtree and puts it on the clipboard. Two
existing mechanisms could power it, and the issue is explicit that the choice
should be deliberate:

1. **Client-side sweep.** Reuse the explorer's sweep planning and budget maths
   (`explorer-core.js`, `dcsStudio.explorerWildcardDepth`) to fetch the subtree
   over RPC, then serialize locally. Honest incremental progress, cancellable —
   at the cost of N round-trips, with the sim doing work per request.
2. **Sim-side serialize.** The `dbExport` path already serializes whole tables in
   one call on the sim side. A variant returning JSON over RPC — or writing a
   temp file the host reads and deletes — is one round-trip.

The constraint that decides it is the bridge's, not the feature's: a **32MB
payload cap and a 30s response deadline**. `_G` subtrees can exceed both, and the
`-32002` semantics exist precisely so an oversized request refuses honestly
instead of stalling the pump. Route 2 meets that wall as a single all-or-nothing
request. Route 1 meets it incrementally and can stop with a partial result.

There is one rule neither route may bend. `_G` reaches itself, and the export
serializer already implements cycle and identity handling. Copy Deep must use
**the same rules**, or the product ships two features that disagree about what a
table is.

This blocks the Copy Deep half of card 45 — the two routes have different
failure modes, different cancellation stories, and different code homes.

## Decision

**Proposed: route 1, the client-side sweep** — awaiting the owner's acceptance.

Route 2 is faster in the common case and it is genuinely the more elegant
mechanism; it is declined on behaviour at the limit. A single-shot serialize of
an oversized subtree can only fail, and the user's request — copy this node —
gives no signal in advance about which side of 32MB they are on. The sweep
degrades: it copies what it reached and says so.

The sim also runs single-threaded, and the mission mailbox is one slot. A long
sim-side serialize occupies that slot for its duration with no way to abandon it;
the sweep already runs at concurrency 1 with a generation counter that cancels
in-flight work, which is the machinery a user pressing Escape needs.

## Consequences

- Copy Deep inherits the sweep's budget and its cancellation, rather than
  introducing a second concurrency model against the sim.
- The clipboard payload must carry a **truthful partial marker** when the budget
  is hit — "truncated at N entries / M bytes". A silently partial deep copy is
  worse than the shallow copy it replaces, because it looks complete.
- The node needs a busy state while the fetch runs. The copy icon already has a
  disabled state to build on.
- Cycle and identity handling is shared with the export serializer by
  construction, not by convention — this wants to be the same function, not the
  same behaviour reimplemented.
- Large subtrees will be slower than route 2 would have been. That is the
  accepted cost: a slow honest answer over a fast one that cannot fail
  gracefully.
- Copy Deep belongs in the context menu from
  [#76](https://github.com/flying-dice/dcs-studio/issues/76), which per
  [decision 13](13-explorer-as-its-own-panel.md) belongs in the new Explorer
  panel. Sequencing matters: #75 → #76 → #77.
