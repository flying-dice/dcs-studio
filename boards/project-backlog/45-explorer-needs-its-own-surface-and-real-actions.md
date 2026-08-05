---
column: todo
labels: [bug, webview, extension]
priority: med
review-verdict: pending
updatedAt: 2026-08-05T19:07:50.000Z
---
# The State Explorer needs its own surface, and real actions on it

Covers [#75](https://github.com/flying-dice/dcs-studio/issues/75),
[#76](https://github.com/flying-dice/dcs-studio/issues/76) and
[#77](https://github.com/flying-dice/dcs-studio/issues/77). These are not three
themes, they are one chain, and the issues say so: #76 notes "if #75 lands
first, do this there", and #77 puts Copy Deep in #76's context menu. Doing them
out of order means building the context menu inside the console panel and moving
it a week later.

**Order: #75 → #76 → #77.**

## #75 — promote the Explorer to its own panel

Owner wanted console left, explorer right. Two shapes in
`src/bridge/consolePanel.ts` make it impossible: `ConsolePanel.current`
(`:33`) is a singleton, so a second `dcs.bridge.console` just reveals the
existing panel (`:43-45`); and the explorer is a **tab inside the same webview**
(`:19-24`), so console and explorer are mutually exclusive per pixel.

`dcs.explorer.open` opening its own `ExplorerPanel` — own view type, own
singleton is fine — reusing `explorer-core.js` and the presenter machinery. VS
Code's native editor-group splitting then gives the layout with no
multi-instance semantics to invent. The `BridgeClient`s already multiplex
callers, so two panels sharing them is the wiring the log/console pair uses now.

The wildcard-depth config push (`explorerConfig`, `consolePanel.ts:84-88`) moves
with it. The webview contract partitions per panel, so this is a new contract
entry and census row, with the console's contract **losing** the explorer
messages rather than duplicating them.

Either keep the console's explorer tab for one release behind a "pop out"
affordance, or remove it in the same change. **Do not ship two half-synced
explorers.**

*Rejected alternative:* true multi-instance consoles. Per-instance REPL
history/state keys, sweep-budget fan-out, and no user story the dedicated panel
does not already satisfy.

## #76 — right-click Copy is dead

The explorer never handles `contextmenu`, so right-click gets VS Code's default
webview menu, whose Copy copies the text *selection* — and a tree row is not
selected text, so it copies nothing. Meanwhile the per-node icon
(`console-explorer.js:174-185`) runs the real copy-children-as-JSON. Two copy
affordances, one dead, no indication why.

Stamp rows with `data-vscode-context` (`webviewSection`,
`preventDefaultContextMenuItems: true`, node identity) and contribute the real
actions to `menus.webview/context` scoped to that section.

## #77 — Copy Deep

The tree is lazy, so the per-node copy takes only what is **loaded**; collapsed
descendants are absent from the clipboard. The only way to capture a full
subtree today is the file-shaped, table-rooted JSON export.

Two mechanisms, and the card must pick deliberately:

1. **Client-side sweep** — reuse the sweep planning/budget math. Honest
   progress, cancellable; N round-trips with the sim working per request.
2. **Sim-side serialize** — the dbExport path already serializes whole tables in
   one call. One round-trip, but mind the bridge's 32MB payload cap and 30s
   deadline: a huge table must **refuse honestly** rather than stall the pump.

Either way: a depth/size budget with a truthful partial marker, a busy state on
the node, and — critically — the **same cycle/identity rules the export
serializer already uses**. `_G` reaches itself, and the two features must not
disagree about what a table is.

## Blocked on two decisions

- [Decision 13](../../decisions/13-explorer-as-its-own-panel.md) (**Proposed**) —
  the explorer becomes its own panel, and what happens to the console's tab in
  the same change. Blocks the whole chain, since #76 and #77 land wherever this
  puts them.
- [Decision 14](../../decisions/14-how-copy-deep-resolves-a-subtree.md)
  (**Proposed**) — client-side sweep vs sim-side serialize for Copy Deep.
  Blocks #77 only; #75 and #76 can proceed once 13 is accepted.

## Checklist

- [ ] Decisions 13 and 14 accepted
- [ ] `ExplorerPanel` with its own view type and `dcs.explorer.open`
- [ ] `explorerConfig` push moves; console contract loses the explorer messages
- [ ] New contract entry and census row
- [ ] Console's explorer tab either popped-out or removed — not duplicated
- [ ] Rows stamped with `data-vscode-context`; real actions in `menus.webview/context`
- [ ] Decision recorded on Copy Deep's mechanism (sweep vs sim-side)
- [ ] Budget with truthful partial-result marker; oversized subtree refuses honestly
- [ ] Copy Deep shares the export serializer's cycle/identity rules

## Comments

- **claude** (2026-08-05T19:07:50.000Z): Raised from the v0.17.0 QA batch. #76 was nearly picked up standalone earlier in this session and deliberately was not — with #75 open, the context menu would have been built into the console panel and then moved. That is the whole reason these three share a card.
