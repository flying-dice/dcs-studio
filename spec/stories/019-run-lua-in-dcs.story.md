# 019 — Run a Lua File in DCS (without debugging)

## Story

> **As a** scripter iterating on a file,
> **I want** to run the current editor's Lua in the mission or GUI environment straight from the editor title,
> **so that** I see results and `print` output in seconds without setting up a debug session.

## Context

- Entry points: **"Run Lua in DCS Mission"** (`dcs.debug.runMission`) and **"Run Lua in DCS GUI (Hooks)"** (`dcs.debug.runGui`) in the editor-title run (▷) dropdown for any `.lua` file except `MissionScripting.lua`, and the Command Palette (which excludes it too).
- "Run" is the debugger's `noDebug` path — breakpoints are ignored; the chunk is evaluated whole.

```gherkin
Feature: Run Lua in the sim

  Background:
    Given the bridge is connected
    And a .lua file is the active editor

  Scenario: Editor-title run entries
    Then the run dropdown offers, in order:
      "Debug Lua in DCS Mission", "Run Lua in DCS Mission",
      "Debug Lua in DCS GUI (Hooks)", "Run Lua in DCS GUI (Hooks)"
    But not on MissionScripting.lua

  Scenario: Running in an environment
    When the user picks "Run Lua in DCS Mission"
    Then a dirty document is saved first
    And the Debug Console logs
      "Running <file> in the mission environment…"
    And breakpoints are ignored
    And a non-nil return value prints as "→ <json result>"
    And print(...) output streams to the Debug Console
    And the session terminates when the script finishes

  Scenario: Not a Lua file
    Given the active editor is not a .lua file
    Then the command fails with "Open a .lua file to run it in DCS."

  @chaos
  Scenario Outline: Targets the run command will not accept
    Given <target>
    When the user runs "Run Lua in DCS Mission"
    Then it fails with "Open a .lua file to run it in DCS."
    And no debug session is started

    Examples:
      | target                                              |
      | nothing is open and no uri was passed               |
      | the target is an unsaved, untitled buffer           |
      | the target is a .md file                            |

  @chaos
  Scenario: MissionScripting.lua, however the command is reached
    Given MissionScripting.lua is the active editor
    Then the four run/debug entries are hidden from the editor-title,
      editor-context, explorer-context and Command Palette menus
    But a `when` clause governs menus only, so the command handler refuses it
      as well — from the palette, a keybinding, or another extension
    And it fails with "MissionScripting.lua defines the mission sandbox — it
      cannot be run or debugged in DCS. Use “DCS Studio: Desanitize
      MissionScripting.lua” to edit what it allows."
    And no debug session is started, so the file that defines the mission
      sandbox is never evaluated inside it
    But a file merely named like it, such as my-MissionScripting.lua, runs
      normally

  @chaos
  Scenario: MissionScripting.lua reached by F5, with no launch.json
    Given MissionScripting.lua is the active editor
    And there is no launch.json, so F5 builds a configuration from that editor
    Then the same refusal is shown and no session is started
    Because this route never passes the command handler at all — it is the
      debug configuration provider that answers F5

  @chaos
  Scenario: MissionScripting.lua named by a hand-written launch.json
    Given a launch.json whose program is MissionScripting.lua, spelled with
      either separator, or as "${file}" while it is the active editor
    Then the same refusal is shown and no session is started
    Because "${file}" is substituted by VS Code after the configuration is
      resolved, so the target is only knowable at the last gate before launch
    And launch.json is not opened for editing — the configuration is not
      malformed, the target is refused

  @chaos
  Scenario: The file cannot be read
    Given the program named by the session is not on disk (deleted, renamed, a dropped share)
    And it is not open in an editor either
    Then the run aborts with "Cannot read <path>: <reason>" on stderr
    And nothing is sent to the sim

  @chaos
  Scenario: Unsaved edits are what runs
    Given the .lua file has unsaved changes
    When the user runs it
    Then the buffer is saved first
    And the text evaluated is the live buffer's, not a re-read of disk
    And a same-named document from another scheme (a diff view) does not win

  Scenario: Bridge offline
    Given the bridge is not connected
    Then the run aborts with
      "The DCS bridge is not connected. Launch DCS with the bridge (command: \"DCS Studio: Launch DCS (with bridge)\") and wait for the status bar to show DCS online."

  @chaos
  Scenario Outline: A mission run names the actual reason it cannot start
    Given "Run Lua in DCS Mission" is picked and the mission bridge is offline
    And <situation>
    Then the run aborts before any code is sent, with "<message>"
    And the reason is shown as a notification as well as on the Debug Console

    Examples:
      | situation                                              | message                                                                                                                                                                    |
      | DCS is not running at all                              | The DCS bridge is not connected. Launch DCS with the bridge (command: “DCS Studio: Launch DCS (with bridge)”) and wait for the status bar to show DCS online.               |
      | DCS is up and MissionScripting.lua is still sanitized   | The mission bridge is not connected: MissionScripting.lua is sanitized, so it cannot load. Run “DCS Studio: Desanitize MissionScripting.lua”, restart DCS, then start a mission. |
      | DCS is up, desanitized, but no mission is loaded        | The mission bridge is not connected — start a mission in DCS (it boots automatically a moment after mission start and only runs while a mission is loaded).                 |
      | MissionScripting.lua cannot be read to tell either way  | The mission bridge is not connected — start a mission in DCS (it boots automatically a moment after mission start and only runs while a mission is loaded).                 |

  @chaos
  Scenario: The script raises
    When the chunk errors in the sim
    Then the Lua error is written to the Debug Console as stderr
    And the session exits with code 1 and terminates
    And any print(...) output produced before the error is drained first

  @chaos
  Scenario: The bridge drops mid-run
    Given the chunk is running in the sim
    When DCS quits (or the mission ends, for a mission run)
    Then the rejection text ("Mission bridge disconnected") is written to stderr
    And the session terminates instead of waiting on a call that will never answer

  @chaos
  Scenario: Breakpoints are inert for a run
    Given a run-without-debugging session is in progress
    When the user sets or moves a breakpoint in the file
    Then no breakpoint is pushed to the sim at all
    And the registry is neither cleared nor repopulated —
      the chunk runs outside the line hook, so a breakpoint would either be
      ignored or stop an unrelated script

  @chaos
  Scenario: Stopping a run that already finished
    Given the run completed and the session terminated
    When VS Code disconnects the session
    Then no stop is sent to the sim
    And exactly one "terminated" event is emitted, not two

  @chaos
  Scenario: Running the same file twice in a row
    Given a run has finished
    When the user picks "Run Lua in DCS Mission" again
    Then a second, independent session starts
    And its output tail begins after the current console ring position,
      so the first run's print output is not replayed into it
```
