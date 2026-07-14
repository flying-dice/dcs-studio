# 014 — Inject & Eject the Bridge

## Story

> **As a** developer who wants editor↔sim connectivity,
> **I want** one command to deploy the bridge DLLs and GameGUI hook into my Saved Games folder, and one to remove them,
> **so that** the next DCS start loads the JSON-RPC bridges — and I can cleanly back them out.

## Context

- Commands: **"DCS Studio: Inject Bridge into DCS"** (`dcs.bridge.inject`) and **"DCS Studio: Eject Bridge from DCS"** (`dcs.bridge.eject`).
- Inject copies both DLLs to `<SavedGames>\Mods\tech\DcsStudio\bin\` (`dcs_studio_gui.dll` + `dcs_studio_mission.dll`) and the hook to `<SavedGames>\Scripts\Hooks\DcsStudio.lua`, and removes stale single-DLL-era artifacts. Freshly built DLLs (story 016) are preferred over the shipped ones.
- DCS only loads the files at startup, and holds a lock on the DLLs while running.

```gherkin
Feature: Bridge injection

  Scenario: Injecting the bridge
    When the user runs "Inject Bridge into DCS"
    Then both bridge DLLs and the hook are copied into the Saved Games folder
      (directories created as needed, existing files overwritten)
    And a toast confirms
      "Bridge injected into <writeDir>. Restart DCS (or run DCS Studio: Launch DCS) to load it."

  Scenario: Saved Games resolution
    Given "dcsStudio.savedGamesPath" is set
    Then that folder is used
    But when it is empty
    Then the first existing of "Saved Games\DCS" or "Saved Games\DCS.openbeta" is used

  Scenario: DCS is running and holds the DLLs
    Given DCS is running with the bridge loaded
    When the user injects again
    Then the copy fails with
      "Could not overwrite the bridge DLLs — DCS appears to be running. Close DCS and inject again."

  Scenario: Freshly built DLLs win
    Given the user has built the bridge from source (story 016)
    When they inject
    Then the locally built DLLs are deployed instead of the shipped ones

  Scenario: Changes need a restart
    Given the hook or DLL was updated and re-injected
    Then the new code is only picked up when DCS next starts

Feature: Bridge ejection

  Scenario: Ejecting
    When the user runs "Eject Bridge from DCS"
    Then the deployed files (both DLLs and the hook) are removed (best-effort)
    And a toast confirms "Bridge ejected from <writeDir>."

  Scenario: Automatic cleanup on shutdown
    When the extension deactivates
    Then the bridge files are ejected if DCS is not holding the DLLs
```
