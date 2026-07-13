# 022 — Debug Lua inside DCS: Errors & Sim Safety

## Story

> **As a** developer debugging inside a running sim,
> **I want** uncaught errors to pause with the crash frames inspectable, and hard guarantees that a lost editor can never freeze DCS,
> **so that** I can diagnose failures at the moment they happen without ever risking the sim session.

## Context

- `pauseOnError` (launch configuration, default `true`) controls break-on-uncaught-error.
- While paused, the in-sim engine pumps the RPC queue itself; the editor polls session state every 250 ms. A pause with no polling client auto-continues after 30 seconds.

```gherkin
Feature: Pause on error

  Scenario: Uncaught error pauses with frames inspectable
    Given a session with pauseOnError enabled (the default)
    When the script raises an uncaught error
    Then execution stops with reason "exception" described "Paused on error"
    And the error message and traceback are shown
    And the erroring frames, scopes and variables are inspectable
    When the user resumes
    Then the run ends and the error still propagates

  Scenario: pauseOnError disabled
    Given the launch configuration sets pauseOnError to false
    When the script raises an uncaught error
    Then the error is reported and the session ends without holding the sim

Feature: The sim is never held hostage

  Scenario: Editor vanishes while paused
    Given execution is paused at a breakpoint
    When the editor stops polling for 30 seconds
      (closed window, crashed VS Code)
    Then the pause auto-continues
    And the sim resumes normally

  Scenario: The sim stays responsive to the editor while frozen
    Given the sim thread is frozen at a breakpoint
    Then the editor can still inspect, step and evaluate
      because the bridge keeps serving requests on a background thread

  Scenario: Bridge disconnects mid-session
    Given a debug session is running
    When the bridge connection is lost
    Then the session ends with
      "The DCS bridge disconnected — the debug session was abandoned."

  Scenario: Breakpoint update failure is non-fatal
    Given the session cannot push a breakpoint change to the sim
    Then the Debug Console notes
      "Could not update breakpoints in <file>: <message>"
    And the session continues
```
