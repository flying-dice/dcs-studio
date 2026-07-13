# 014 — Inject & Eject the Bridge

## Story

> **As a** developer who wants editor↔sim connectivity,
> **I want** one command to deploy the bridge DLL and GameGUI hook into my Saved Games folder, and one to remove them,
> **so that** the next DCS start loads the JSON-RPC bridge — and I can cleanly back it out.

## Context

- Commands: **"DCS Studio: Inject Bridge into DCS"** (`dcs.bridge.inject`) and **"DCS Studio: Eject Bridge from DCS"** (`dcs.bridge.eject`).
- Inject copies the DLL to `<SavedGames>\Mods\tech\DcsStudio\bin\dcs_studio.dll` and the hook to `<SavedGames>\Scripts\Hooks\DcsStudio.lua`. A freshly built DLL (story 016) is preferred over the shipped one.
- DCS only loads the files at startup, and holds a lock on the DLL while running.

```gherkin
Feature: Bridge injection

  Scenario: Injecting the bridge
    When the user runs "Inject Bridge into DCS"
    Then the bridge DLL and hook are copied into the Saved Games folder
      (directories created as needed, existing files overwritten)
    And a toast confirms
      "Bridge injected into <writeDir>. Restart DCS (or run DCS Studio: Launch DCS) to load it."

  Scenario: Saved Games resolution
    Given "dcsStudio.savedGamesPath" is set
    Then that folder is used
    But when it is empty
    Then the first existing of "Saved Games\DCS" or "Saved Games\DCS.openbeta" is used

  Scenario: DCS is running and holds the DLL
    Given DCS is running with the bridge loaded
    When the user injects again
    Then the copy fails with
      "Could not overwrite dcs_studio.dll — DCS appears to be running. Close DCS and inject again."

  Scenario: A freshly built DLL wins
    Given the user has built the bridge from source (story 016)
    When they inject
    Then the locally built DLL is deployed instead of the shipped one

  Scenario: Changes need a restart
    Given the hook or DLL was updated and re-injected
    Then the new code is only picked up when DCS next starts

Feature: Bridge ejection

  Scenario: Ejecting
    When the user runs "Eject Bridge from DCS"
    Then both deployed files are removed (best-effort)
    And a toast confirms "Bridge ejected from <writeDir>."

  Scenario: Automatic cleanup on shutdown
    When the extension deactivates
    Then the bridge files are ejected if DCS is not holding the DLL
```
