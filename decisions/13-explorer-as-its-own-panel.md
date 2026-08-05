---
status: Proposed
date: 2026-08-05
---
# Decision 13 — The State Explorer becomes its own panel

## Context

[Issue #75](https://github.com/flying-dice/dcs-studio/issues/75), board card 45.
The owner wanted the console on one side and the state explorer on the other.
That is currently impossible, for two compounding reasons in
`src/bridge/consolePanel.ts`:

1. **The panel is a singleton** — `ConsolePanel.current` (`:33`), so a second
   `dcs.bridge.console` just reveals the existing panel (`:43-45`).
2. **The explorer is a tab inside that same webview** (`:19-24`), so console and
   explorer are mutually exclusive per pixel.

Together: you cannot open two panels and switch each to a different tab.

Two shapes were considered.

**Promote the explorer to its own panel.** `dcs.explorer.open` opening an
`ExplorerPanel` with its own view type — its own singleton is fine — reusing
`explorer-core.js` and the existing presenter machinery. VS Code's native
editor-group splitting then produces the requested layout with no multi-instance
semantics to invent. The `BridgeClient`s already multiplex callers, so two panels
sharing them is the same wiring the log/console pair uses today.

**True multi-instance consoles** — N console panels, each with tabs. Heavier:
per-instance REPL history and state keys, sweep-budget config fan-out, and no
user story beyond the split-screen one that a dedicated panel already satisfies.

This blocks the rest of card 45. [#76](https://github.com/flying-dice/dcs-studio/issues/76)
(the context menu) says outright that if #75 lands first the work belongs in the
new panel, and [#77](https://github.com/flying-dice/dcs-studio/issues/77) (Copy
Deep) belongs in #76's menu. Building the context menu into the console panel
first means moving it afterwards. Earlier in this session #76 was nearly picked
up on its own and deliberately was not, for exactly that reason.

## Decision

**Proposed: promote the Explorer to its own panel; reject multi-instance
consoles** — awaiting the owner's acceptance. This is the direction the issue
itself recommends, recorded here because it is a structural change with a
contract consequence rather than a preference.

A **third question comes with it and must be answered at the same time**: what
happens to the explorer tab already inside the console. Either keep it for one
release behind a "pop out" affordance, or remove it in the same change. Both are
defensible. What is not defensible is shipping two half-synced explorers, and
that is the outcome if this is left to be decided during implementation.

The recommendation is to **remove it in the same change**. A deprecation window
is worth paying for when users have automation or muscle memory built on the old
surface; a tab inside a debug console has neither, and keeping it means every
explorer fix lands twice for a release.

## Consequences

- A new panel means a new webview contract entry and census row. The console's
  contract **loses** the explorer messages rather than duplicating them — the
  partitioning is per panel by design.
- The wildcard-depth config push (`explorerConfig`, `consolePanel.ts:84-88`)
  moves with the explorer.
- #76 and #77 land in their final home first time.
- The console panel gets simpler: it goes back to being a REPL, a status line and
  a message router, without a second surface embedded in it.
- Removing the tab in the same change is a visible behaviour change for anyone
  who used it during the v0.17.x line. It needs a release-note line, not just a
  commit message.
- Multi-instance consoles stay unavailable. If a story for them appears later,
  this record does not block it — it records that no such story existed now.
