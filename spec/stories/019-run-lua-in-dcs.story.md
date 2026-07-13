# 019 — Run a Lua File in DCS (without debugging)

## Story

> **As a** scripter iterating on a file,
> **I want** to run the current editor's Lua in the mission or GUI environment straight from the editor title,
> **so that** I see results and `print` output in seconds without setting up a debug session.

## Context

- Entry points: **"Run Lua in DCS Mission"** (`dcs.debug.runMission`) and **"Run Lua in DCS GUI (Hooks)"** (`dcs.debug.runGui`) in the editor-title run (▷) dropdown for any `.lua` file except `MissionScripting.lua`, and the Command Palette.
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

  Scenario: Bridge offline
    Given the bridge is not connected
    Then the run aborts with
      "The DCS bridge is not connected. Launch DCS with the bridge (command: \"DCS Studio: Launch DCS (with bridge)\") and wait for the status bar to show DCS online."

  Scenario: Mission environment with no mission
    Given the mission environment is targeted and no mission is running
    Then a note appears:
      "Note: DCS reports no mission time — mission scripts need a running mission."
```
