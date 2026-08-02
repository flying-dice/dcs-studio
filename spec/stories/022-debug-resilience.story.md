# 022 — Debug Lua inside DCS: Errors & Sim Safety

## Story

> **As a** developer debugging inside a running sim,
> **I want** uncaught errors to pause with the crash frames inspectable, and hard guarantees that a lost editor can never freeze DCS,
> **so that** I can diagnose failures at the moment they happen without ever risking the sim session.

## Context

- `pauseOnError` (launch configuration, default `true`) controls break-on-uncaught-error.
- While paused, the in-sim engine pumps the RPC queue itself; the editor polls session state every 250 ms. A pause with no polling client auto-continues after 30 seconds.
- Both sim-safety budgets — the 30 second idle release and the 2 second ceiling on one evaluation — are measured on the bridge DLL's own monotonic clock, never on a clock belonging to the debugged Lua state.

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

  Scenario: A held pause is visible as "sim idle", not "mission"
    Given execution is held at a mission breakpoint
    Then the GUI bridge's frame drain stops and the bridge answers -32002
    And the status bar shows "$(debug-pause) DCS: sim idle" rather than
      "DCS: mission <N>s"
    And the state clears on the first served call (a step, an eval) rather
      than waiting out the stalled 10 s ping cadence

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
  Scenario: The idle release does not depend on the debugged state's clock
    Given the mission state was desanitized only far enough for the bridge to
      load, so it has no os.clock — and DCS's timer.getTime is model time,
      which is frozen for as long as the paused chunk holds the sim thread
    When execution is held at a breakpoint and the editor stops polling
    Then the countdown still advances, because it is read from the bridge
      DLL's monotonic clock rather than from anything in the Lua state
    And the pause auto-continues and the chunk runs on to completion

  @chaos
  Scenario: An evaluation that never returns
    Given execution is paused
    When the user evaluates an expression that loops forever
    Then it is cut off after 2 seconds and comes back as a failed evaluation
      naming the timeout, rather than running on the sim thread until it ends
    And an expression that yields instead of returning is refused likewise
    And the pause is still there to inspect, evaluate again, step or resume
    And the idle release can therefore never be starved by a watch expression

  @chaos
  Scenario: A breakpoint condition that never returns
    Given a breakpoint carries a condition that loops forever
    When its line is reached
    Then the condition is cut off by the same 2 second ceiling — and it is
      evaluated in the line hook, before any pause exists to time out
    And the breakpoint fails open as any broken condition does: it stops, and
      the snapshot carries the timeout as its condition error

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
