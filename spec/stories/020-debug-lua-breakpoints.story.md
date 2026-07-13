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
```
