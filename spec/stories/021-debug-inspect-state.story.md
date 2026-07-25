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

  @chaos
  Scenario Outline: Values with no children
    When the user inspects a variable holding <value>
    Then it renders as "<preview>" with nothing to expand,
      because only tables expand in this Lua

    Examples:
      | value       | preview  |
      | a function  | function |
      | userdata    | userdata |
      | a coroutine | thread   |

  @chaos
  Scenario: A cyclic table
    When the user expands a table that contains itself, round and round
    Then each expansion mints a fresh per-pause ref
    And past 100000 refs in one pause further values render as leaves,
      so a cycle cannot pin unbounded memory in the sim
    And no cycle ever crosses the bridge — only preview strings do

  @chaos
  Scenario: A table far bigger than the view
    Given a table with more than 1000 entries
    Then its preview reads "table (1000+)" instead of counting the whole table
    When the user expands it
    Then the first 1000 keys come back, numeric ascending first then
      case-insensitively alphabetical
    And a final entry named "…" valued "(truncated)" marks the cut

  @chaos
  Scenario: A very long or non-ASCII string
    When the user inspects a string longer than 60 bytes
    Then the preview is its first 57 bytes followed by "...", in quotes
    And carriage returns and newlines are flattened to spaces so the tree
      stays one line per variable
    And a cut that lands mid-character is decoded lossily to the Unicode
      replacement character rather than failing the request

  @chaos
  Scenario: A hostile __tostring cannot break a pause
    Given a table or userdata whose __tostring metamethod raises
    Then it is still previewed by kind and count — the debugger never calls
      __tostring on a table or on userdata
    And inspection proceeds normally

  @chaos
  Scenario: A key whose __tostring raises
    Given a table keyed by an object whose __tostring raises
    When the user expands that table
    Then only that one expansion fails, carrying the real Lua error to the
      Variables view
    And the session stays paused with everything else inspectable

  @chaos
  Scenario: Inspecting after the frame is gone
    Given the user resumed from a stop
    When a variables request for a ref from that stop arrives late
    Then it comes back empty — refs are released at every resume
    And a scopes request for a frame the snapshot no longer has yields none
    And an evaluate fails with "not paused" before it reaches the sim

  @chaos
  Scenario: Evaluating in a frame the engine does not have
    When an evaluate names a frame index the pause snapshot never produced
    Then it quietly falls back to the top frame's environment
    And only when there is no frame environment at all does it fail with
      "no active frame"

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

  @chaos
  Scenario: The right-hand side raises
    When the user types "x = target:getPoint()" and the call raises
    Then the evaluation fails with the real Lua error, not a generic one
    And nothing is assigned — "x" keeps the value it had

  @chaos
  Scenario: An assignment that is not one
    When the user types "x =" with nothing after it
    Then it is not treated as an assignment at all
    And it fails with the compile error from loading it as a statement
    And "x == 42" is likewise read as a comparison, never as an assignment

  @chaos
  Scenario: Assigning a name the paused frame does not have
    When the user assigns to a name that is neither a local nor an upvalue
      of the frame
    Then the value is written to the global table, for real, in the live sim
    And a mistyped local name therefore creates a global rather than failing

  @chaos
  Scenario Outline: The live stack no longer matches the paused frame
    Given the frame's captured environment still names the local
    When the live stack cannot be walked back to it because <situation>
    Then the assignment fails with "<message>" and nothing is written

    Examples:
      | situation                                   | message                                        |
      | the run has already ended                   | no live pause to assign into                   |
      | the hook frame is no longer on the stack    | paused frame is not live (step once and retry) |
      | the frame index is past the live Lua frames | frame not found on the live stack              |
      | the live frame has no slot of that name     | no local 'x' in the live frame                 |

  @chaos
  Scenario: Evaluation is not a sandbox
    Given a watch expression that calls a function with side effects
    Then the call really executes in the paused sim and its effects persist
      after the resume
    And because watches re-evaluate at every stop, it fires again at each one
    And only a bare-name write is intercepted — "a.b = 1" mutates the real
      table "a"

Feature: Output streaming

  Scenario: print goes to the Debug Console
    Given the debugged chunk calls print(...)
    Then its output streams into the Debug Console as stdout
    And lines from a previous session are never replayed

  @chaos
  Scenario: The console ring hiccups
    Given the session is streaming print output
    When one console read fails, or comes back with no lines
    Then the cursor does not move, so nothing is skipped and nothing replays
    And the next poll picks up where it left off
```
