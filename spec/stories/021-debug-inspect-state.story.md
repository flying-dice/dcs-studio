# 021 — Debug Lua inside DCS: Inspect & Modify State

## Story

> **As a** developer paused at a breakpoint inside the sim,
> **I want** the full VS Code inspection surface — call stack, scopes, lazy table expansion, watches, hover eval, and real assignment from the Debug Console,
> **so that** I can understand and even fix live state without restarting the mission.

## Context

- Applies while a `dcs-lua` session (story 020) is paused. Name resolution for evaluation walks the paused frame's locals → upvalues → globals.
- The Upvalues scope exists only where the host exposes it (present in the mission environment, stripped in GUI/hooks).

```gherkin
Feature: Inspecting the paused sim

  Background:
    Given a debug session is paused at a breakpoint

  Scenario: Call stack
    Then the Call Stack shows the paused frames
    And frames backed by a real file are clickable to their source
    And synthetic frames render subtly

  Scenario: Scopes
    Then each frame offers a "Locals" scope
    And an "Upvalues" scope where the environment supports it
    And the top frame offers a "Globals" scope marked expensive

  Scenario: Lazy variable expansion
    When the user expands a table variable
    Then children load on demand, numeric keys first then alphabetical,
      capped at 1000 with a truncation marker
    And long string previews are truncated

  Scenario: Watch expressions
    Given the user adds a watch
    Then it re-evaluates at every stop against the current frame

  Scenario: Hover evaluation
    When the user hovers a symbol in the editor while paused
    Then its current value shows in the hover
    And hover failures stay silent

  Scenario: Evaluation requires being paused
    Given the session is running (not paused)
    When the user evaluates in the Debug Console
    Then it fails with "not paused"

Feature: Real assignment from the Debug Console

  Background:
    Given a debug session is paused

  Scenario: Assigning a local
    When the user types "x = 42" in the Debug Console
    And "x" is a local in the current frame
    Then the live local is written through the debug API
    And the result renders "42 (assigned)"
    And the Variables view refreshes

  Scenario: Assignment resolution order
    Then a top-level assignment targets a local first,
      then an upvalue, then a global

  Scenario: Hidden assignments are refused loudly
    When an assignment to a bare name appears inside a larger statement
    Then it is rejected with
      "assignment to '<name>' here would be lost — use a top-level `name = value`"

  Scenario: Unsupported upvalue assignment
    Given the host cannot write upvalues in this environment
    Then the assignment fails with
      "upvalue assignment is not supported in this host"

Feature: Output streaming

  Scenario: print goes to the Debug Console
    Given the debugged chunk calls print(...)
    Then its output streams into the Debug Console as stdout
    And lines from a previous session are never replayed
```
