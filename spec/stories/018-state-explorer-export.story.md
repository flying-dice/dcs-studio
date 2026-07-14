# 018 — Explore & Export Sim State

## Story

> **As a** scripter reverse-engineering DCS state,
> **I want** a single `_G` tree per environment that I can filter, sweep and drill into lazily — with function signatures and per-node JSON export,
> **so that** I can navigate structures like `db`, `Export` or `env.mission` the way I would in dcsfiddle, without writing dump scripts.

## Context

- The **Explorer** tab of the DCS Lua Console (story 017). Uses the same environment picker.
- A single `_G` root per environment — no expression box. Fully lazy; the tree is cached per env (switching env keeps each tree and its live sim-side refs).
- Pure logic (glob matcher, filter modes, match propagation, sweep budget math, copy serialization) lives in `media/explorer-core.js` (`DcsExplorerCore`), vitest-tested.
- Function signatures are resolved sim-side via `repl_signature` — the runtime reads parameter names off a call hook and **never runs the function**.
- Exports are serialized sim-side to a temp file, then saved wherever the user chooses.

```gherkin
Feature: State explorer

  Background:
    Given the DCS Lua Console is open on the Explorer tab
    And the bridge is connected

  Scenario: A single _G root per environment
    When the Explorer tab is first shown for the selected environment
    Then the environment's "_G" is inspected and its top-level keys render
    And switching environments shows that environment's own cached tree

  Scenario: Type icons and previews
    Then each node shows a type icon (chevron for tables, square-function for
      functions, hash for numbers, toggle for booleans, type for strings, box
      otherwise) and an italic muted preview

  Scenario: Lazy drilling; collapse discards children
    When the user expands a table node
    Then its children load on demand,
      sorted numeric keys first then alphabetical,
      capped at 1000 entries with a "…  (truncated)" marker
    And collapsing the node discards its children
    And re-opening it refetches them (self-healing a stale ref)

  Scenario: Function arity previews and click-to-resolve signatures
    Then a function row previews its arity from debug.getinfo
      (e.g. "function (3 args)", "(2+ args)", "(varargs)", or "(native)")
      without ever calling the function
    When the user clicks a function row
    Then its real parameter names resolve to "name(a, b, c)"
      (a native/C function shows "name()  (native)")

  Scenario: Three-mode live filter keeps ancestors of deep matches
    When the user types in the filter
    Then a filter containing "/" globs the full path (glob subset: * ? **),
      a filter with glob chars globs the basename,
      and a plain filter is a case-insensitive substring
    And matching nodes stay visible along with all their ancestors,
      while unrelated branches hide (nodes stay mounted)

  Scenario: Enter-triggered path sweep, budget-capped
    Given the filter is a path pattern containing "/"
    When the user presses Enter (or clicks the sweep button)
    Then the tree auto-expands closed table nodes on the path toward a match,
      to a depth from the pattern segments (a "**" costs the
      dcsStudio.explorerWildcardDepth setting, default 1),
      bounded by a 200-fetch budget
    And a notice reports when the 200-fetch limit is hit
    And a bare-word (no "/") Enter shows "use a path pattern with /"
    And a mission-environment sweep warns that it can be slow

  Scenario: Copy children as JSON
    When the user clicks a loaded table node's copy button
    Then its children are copied to the clipboard as JSON
    And a check icon confirms for about two seconds

  Scenario: Exporting a table to JSON
    When the user hovers a table row and clicks its export button
    Then the sim serializes the full value to pretty JSON
    And a Save dialog proposes a filename derived from the node path
    And after saving, files under 5 MB open in an editor,
      larger ones report "Exported <size> to <path>"

  Scenario: Export failure
    Given serialization fails sim-side
    Then a notice shows "export failed — <message>"

  Scenario: Refresh releases sim resources
    When the user clicks "Refresh"
    Then the selected environment's tree is dropped and its sim-side refs released
    And "_G" is re-inspected fresh
```
