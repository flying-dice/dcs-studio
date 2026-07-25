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

  @chaos
  Scenario: An error pause is held under the same rule as a breakpoint
    Given pauseOnError is enabled and the script has just raised
    Then the crash frames are held by the same pump, with the line hook
      already removed — stepping after a throw is meaningless
    And an editor that stops polling releases the sim after 30 seconds,
      exactly as at a breakpoint
    And however it is released, the run then ends and the error propagates

  @chaos
  Scenario: Stop is not an error
    Given pauseOnError is enabled and execution is paused
    When the user clicks Stop
    Then the resulting unwind is recognised as a user stop, not an uncaught
      error, so it does not pause again on itself
    And the session ends with exit code 0 and nothing on stderr

  @chaos
  Scenario: A script error that reads like the stop signal
    Given the debugged script raises an error whose text contains
      "debug: stopped"
    Then the engine takes it for a user Stop
    And the run is reported as a clean end — the error is neither paused on
      nor written to the Debug Console  # UNVERIFIED: read from the engine's substring test on the error message; no test covers this collision

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

  @chaos
  Scenario: The editor goes away without disconnecting
    Given execution is paused at a breakpoint
    When the extension host dies without ever sending disconnect
    Then no debug_stop reaches the sim
    And the sim's own idle timer releases the pause and the chunk runs to
      completion
    And the breakpoints left behind in the DLL registry stop nothing,
      because no line hook is installed outside a debug_run
    And the next session clears that registry before it starts

  @chaos
  Scenario: A state answer that arrives after the session ended
    Given a debug_state poll is in flight
    When the session ends before it answers
    Then the late snapshot is discarded
    And no "stopped" event re-opens the debug UI on a dead session

  @chaos
  Scenario: The heartbeat's margin is deliberate
    Given execution is paused and the editor is polling every 250 ms
    Then polls never overlap, so one slow debug_state suppresses the
      liveness ping entirely rather than piling up requests
    And that is why debug_state carries a 5 second client-side timeout,
      well inside the sim's 30 second idle window

  @chaos
  Scenario: The idle release needs a real clock
    Given the debugged Lua state has no os.clock, so the engine falls back
      to DCS model time (or, failing that, to a constant)
    When execution is held at a breakpoint and the editor stops polling
    Then the idle countdown does not advance, because model time is frozen
      while the paused chunk holds the sim thread
    And the auto-continue never fires  # UNVERIFIED: read from the engine's clock fallback — nothing else releases a held pause, so the 30 s guarantee rests on os.clock surviving in the debugged state

  @chaos
  Scenario: An evaluation that never returns
    Given execution is paused
    When the user evaluates an expression that loops forever
    Then it runs on the sim thread inside the pause's own RPC pump
    And neither a resume nor the idle timer is observed until it returns  # UNVERIFIED: no timeout guards a debug_eval, so a runaway watch or condition defeats the 30 s auto-continue

Feature: The sim changes under the session

  @chaos
  Scenario: The mission ends under a live session
    Given a mission-environment session is running
    When the mission ends
    Then the mission bridge stops pumping its queue and the polls time out
    And a lone timeout is retried rather than ending the session — a missed
      ping does not mark the bridge offline either
    When the next mission loads
    Then its fresh Lua state answers "not running" and the session terminates
    And that new state carries no leftover pause, resume or stop request,
      though the breakpoint registry deliberately survives in the DLL

  @chaos
  Scenario: A poll failure is not a disconnect
    Given a debug session is running
    When a single debug_state call fails while the bridge socket is still up
    Then the session keeps polling and says nothing
    And only an actually disconnected bridge ends the session with
      "The DCS bridge disconnected — the debug session was abandoned."

  @chaos
  Scenario: A panic elsewhere in the DLL poisons the shared debug state
    Given another bridge call panicked while holding a debug mutex
    When the editor next reads or writes breakpoints, or the pause snapshot
    Then the poisoned lock is recovered and the call is served
    And debugging keeps working for the rest of the DCS session, rather than
      the bridge being bricked until DCS restarts
```
