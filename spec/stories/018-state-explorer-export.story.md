# 018 — Explore & Export Sim State

## Story

> **As a** scripter reverse-engineering DCS state,
> **I want** to inspect any Lua expression as a lazily-expanding tree and export whole tables to JSON,
> **so that** I can drill into structures like `env.mission` or `Export` without writing dump scripts.

## Context

- The **Explorer** tab of the DCS Lua Console (story 017). Uses the same environment picker.
- Exports are serialized sim-side to a temp file, then saved wherever the user chooses.

```gherkin
Feature: State explorer

  Background:
    Given the DCS Lua Console is open on the Explorer tab
    And the bridge is connected

  Scenario: Inspecting an expression
    When the user enters an expression (e.g. "_G", "Export", "env.mission")
      and clicks "Inspect"
    Then the result becomes a root node in the tree
    And table nodes show a twisty and a "table (N)" preview

  Scenario: Lazy drilling
    When the user expands a table node
    Then its children load on demand,
      sorted numeric keys first then alphabetical,
      capped at 1000 entries with a "…  (truncated)" marker

  Scenario: Value previews are typed
    Then strings, numbers/booleans, and tables/functions/userdata
      are visually distinguished in the tree

  Scenario: Exporting a table to JSON
    When the user hovers a table row and clicks its "{}" button
    Then the sim serializes the full value to pretty JSON
    And a Save dialog proposes a filename derived from the node path
    And after saving, files under 5 MB open in an editor,
      larger ones report "Exported <size> to <path>"

  Scenario: Export failure
    Given serialization fails sim-side
    Then the tree shows "export failed — <message>"

  Scenario: Clearing releases sim resources
    When the user clicks "Clear"
    Then the tree empties
    And the sim-side references held for expansion are released
      in every environment that was touched
```
