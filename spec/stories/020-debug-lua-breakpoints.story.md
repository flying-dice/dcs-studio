# 020 — Debug Lua inside DCS: Breakpoints & Stepping

## Story

> **As a** mission or hook developer,
> **I want** real VS Code debugging — breakpoints, conditions, stepping, pause and stop — for scripts running inside the live sim,
> **so that** I can fix logic where it actually executes instead of print-debugging.

## Context

- Debugger type `dcs-lua` ("DCS World Lua") over the bridge, in two environments: `mission` (default) and `gui`.
- Entry points: **"Debug Lua in DCS Mission"** / **"Debug Lua in DCS GUI (Hooks)"** in the editor-title run menu; **F5** on a `.lua` file (defaults to the mission environment); `launch.json` configurations **"DCS: Debug Mission Script"** and **"DCS: Debug Hook (GUI) Script"** (`program`, `env`, `pauseOnError`).
- Mission-environment sessions need a running mission and a desanitized `MissionScripting.lua` (story 013).

```gherkin
Feature: Starting a debug session

  Scenario: F5 on a Lua file
    Given a .lua file is active and the bridge is connected
    When the user presses F5 with no launch configuration
    Then a session starts in the mission environment for the current file
    And the Debug Console logs "Debugging <file> in the mission environment…"

  Scenario: Unsaved edits are honoured
    Given the file has unsaved modifications
    When a session starts
    Then the source is taken from the live editor buffer

  Scenario Outline: Session preconditions
    Given <condition>
    Then the session aborts with "<message>"

    Examples:
      | condition                       | message                                                        |
      | the active editor is not Lua    | Open a .lua file to debug it in DCS.                           |
      | the bridge is not connected     | The DCS bridge is not connected. Launch DCS with the bridge (command: "DCS Studio: Launch DCS (with bridge)") and wait for the status bar to show DCS online. |
      | a session is already running    | a debug session is already running                             |

  Scenario: Sanitized mission environment
    Given MissionScripting.lua has not been desanitized
    When a mission-environment session runs
    Then the run fails explaining the environment is sanitized and telling
      the user to run "DCS Studio: Desanitize MissionScripting.lua",
      restart DCS, start the mission and try again

  @chaos
  Scenario Outline: The mission environment only exists while a mission runs
    Given the GUI bridge is connected but the mission bridge is not
    And <state>
    When a mission-environment session starts
    Then the session aborts with "<message>"
    And the same text is raised as an error notification
    And the session ends quietly with exit code 0, never reaching debug_run
    And MissionScripting.lua is read off disk only because there is already
      a failure to explain

    Examples:
      | state                                   | message                                                        |
      | no mission is loaded                    | The mission bridge is not connected — start a mission in DCS (it boots automatically a moment after mission start and only runs while a mission is loaded). |
      | MissionScripting.lua is still sanitized | The mission bridge is not connected: MissionScripting.lua is sanitized, so it cannot load. Run “DCS Studio: Desanitize MissionScripting.lua”, restart DCS, then start a mission. |
      | MissionScripting.lua cannot be read     | The mission bridge is not connected — start a mission in DCS (it boots automatically a moment after mission start and only runs while a mission is loaded). |

  @chaos
  Scenario Outline: The editor buttons refuse a target that is not a Lua file on disk
    When the user invokes Run or Debug in DCS with <target>
    Then it is refused with "Open a .lua file to run it in DCS."
    And no session is started

    Examples:
      | target                                       |
      | nothing open and no active editor            |
      | an untitled buffer that was never saved      |
      | a document from a non-file scheme (a diff)   |
      | a Markdown file                              |

  @chaos
  Scenario: The script does not compile
    Given the .lua file has a syntax error
    When a session starts
    Then the run comes straight back with "loadstring: <error>" on stderr
    And the session exits with code 1
    And no breakpoint is ever reached

  @chaos
  Scenario: configurationDone arrives before launch
    Given the session was created from an already-resolved configuration
    When configurationDone arrives before the launch request
    Then the run starts from that resolved configuration
    And a later launch request is answered but cannot move an already-fired
      run to the other environment's bridge
    And however many times configurationDone arrives, the run fires once

  @chaos
  Scenario: A second session while one is already running
    Given a debug session is running in DCS
    When another dcs-lua session is started against the same environment
    Then the engine refuses the run with "a debug session is already running"
    And the second session ends immediately with exit code 1
    And the first session keeps running, still holding its own pause  # UNVERIFIED: the second session clears the shared DLL breakpoint registry when it starts and again when it is dismissed, so today the first session silently loses its breakpoints

  @chaos
  Scenario: The sim is paused in DCS when the session starts
    Given a mission is loaded but the sim is paused
    When a mission-environment session starts
    Then its setup calls queue behind the mission bridge's model-time pump,
      which does not run while the sim is paused
    And after the client-side timeout the session aborts with
      "Failed to set breakpoints: Mission bridge call 'debug_clear_breakpoints' timed out"
    And debug_run is never sent

Feature: Breakpoints

  Background:
    Given a debug session is running in DCS

  Scenario: Gutter breakpoints
    Given the user set breakpoints in the .lua file before starting
    Then execution stops on those lines with reason "breakpoint"

  Scenario: Changing breakpoints live
    When the user adds or removes breakpoints while the session runs
    Then the new set takes effect immediately

  Scenario: Conditional breakpoints
    Given a breakpoint has a condition
    Then it only stops when the condition is truthy,
      evaluated against the frame's locals, upvalues and globals

  Scenario: A broken condition fails open
    Given a breakpoint condition raises an error
    Then execution still pauses at that line
    And "breakpoint condition error: <err>" is written to the Debug Console

  @chaos
  Scenario Outline: Breakpoints that can never be hit are still reported verified
    When the user sets a breakpoint <where>
    Then it is answered verified at the line it was requested on
    And it is pushed to the registry like any other
    And it simply never stops, because the line hook only fires on executed
      lines of the running chunk
    And nothing tells the user the breakpoint cannot bind

    Examples:
      | where                                  |
      | on a blank line                        |
      | on a comment                           |
      | past the last line of the file         |
      | in a file this session is not running  |

  @chaos
  Scenario: A hundred breakpoints at once
    When the user sets 100 breakpoints in the debugged file
    Then all of them go to the sim in one debug_set_breakpoints call that
      replaces that source's whole set
    And duplicate lines collapse — the count returned is the number of
      distinct lines
    And there is no cap: every line is stored

  @chaos
  Scenario: The same file under two spellings
    Given breakpoints were set on "C:\mods\Scripts\util.lua"
    When the editor sends a set for "c:\MODS\scripts\util.lua"
    Then both fold to one registry entry — chunkname prefix stripped,
      separators unified, case folded
    And the later set replaces the earlier one rather than competing with it
    And the same file loaded by dofile as "@Scripts/util.lua" still stops
      on those lines

  @chaos
  Scenario: A similarly named file does not inherit breakpoints
    Given breakpoints are registered for ".../scripts/util.lua"
    Then a chunk running as ".../otherscripts/util.lua" never stops on them,
      because a relative spelling matches only at a path boundary
    And a chunk with no name at all matches nothing

  @chaos
  Scenario: Removing the breakpoint you are paused on
    Given execution is paused at a breakpoint
    When the user removes it in the gutter
    Then the source's new set is pushed while the sim is frozen, served by
      the paused state's own RPC pump
    And execution stays where it stopped
    And continuing does not stop there again

  @chaos
  Scenario: The file is edited under a running session
    Given a session is running the source it was launched with
    When the user edits the file and the editor pushes shifted line numbers
    Then the new lines replace the old set in the registry
    And they are matched against the chunk that is still running — the code
      as it was at launch — so a stop can land on a line the user did not mark
    And nothing re-verifies a breakpoint against the running chunk

  @chaos
  Scenario: A condition that assigns instead of comparing
    Given a breakpoint condition of "hp = 0", a typo for "hp == 0"
    Then the write is refused inside the condition's own environment with
      "assignment to 'hp' here would be lost — use a top-level `name = value`"
    And the condition fails open, so execution pauses on that line anyway
    And "breakpoint condition error: <err>" is written to the Debug Console

  @chaos
  Scenario: A blank condition clears rather than never matching
    When the user empties a breakpoint's condition box
    Then the empty condition is omitted from the pushed breakpoint rather
      than sent as an empty string
    And any stale condition on that line is cleared — a whitespace-only
      expression clears it too
    And the breakpoint pauses unconditionally again

Feature: Execution control

  Background:
    Given execution is paused in DCS

  Scenario: Stepping
    Then Step Over, Step Into and Step Out each advance execution
      and stop with reason "step"

  Scenario: Continue
    When the user continues
    Then execution resumes until the next breakpoint or the script ends

  Scenario: Pause (break-all)
    Given the script is running
    When the user clicks Pause
    Then execution stops at the next executed line of debugged code

  Scenario: Stop kills a runaway script
    Given the script is stuck in a loop
    When the user clicks Stop
    Then the chunk is cooperatively unwound at its next line
    And the session ends cleanly without an error report

  @chaos
  Scenario: Stop while paused
    Given execution is paused at a breakpoint
    When the user clicks Stop
    Then the stop request is paired with a continue that releases the pause
      pump, so the chunk resumes straight into the stop check
    And it unwinds at its next line
    And the session ends with exit code 0 and no error reported

  @chaos
  Scenario: Pause clicked while no debugged code is executing
    Given the script is blocked in a call that executes no debugged lines
    When the user clicks Pause
    Then nothing stops until debugged code executes another line
    And the request is consumed by that first line, not honoured again later
    And it cannot survive into a later session, which clears every pending
      pause, stop and resume before it runs

  @chaos
  Scenario: Continue clicked a moment before the stop lands
    Given the user clicks Continue while the chunk is still running
    When the breakpoint is reached an instant later
    Then the stale resume request is dropped as the pause is published
    And the user still gets the stop they were waiting for
```
