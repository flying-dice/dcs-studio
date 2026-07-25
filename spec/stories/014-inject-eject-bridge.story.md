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

  @chaos
  Scenario: The bin and Hooks directories are created under the write dir itself
    Given a write dir "D:\Saved Games\DCS" that has never had a mod installed
    When the user runs "Inject Bridge into DCS"
    Then "D:\Saved Games\DCS\Mods\tech\DcsStudio\bin" is created
    And "D:\Saved Games\DCS\Scripts\Hooks" is created
    # The parent directory is taken with Windows path rules. A POSIX dirname of
    # a "D:\..." path yields ".", which would create the directories beside the
    # editor and leave every copy failing with ENOENT.

  @chaos
  Scenario: A partly copied payload is reported as one
    Given the GUI DLL copies successfully
    But the mission DLL cannot be overwritten because DCS holds it
    When the user runs "Inject Bridge into DCS"
    Then the inject stops at the failing copy — the hook is never copied
    And the already-copied GUI DLL is NOT rolled back
    And the error names both the cause and the state it left behind:
      "Could not overwrite the bridge DLLs — DCS appears to be running. Close
      DCS and inject again. The install is now mixed: dcs_studio_gui.dll was
      replaced and the rest were not — inject again once the problem is fixed,
      because DCS loads them as a set."
    And no success toast is shown
    # Nothing is rolled back on purpose: the file that will not copy is the one
    # a running DCS has loaded, so deleting its already-updated sibling would
    # fail for the same reason while destroying a working install.

  @chaos
  Scenario Outline: Inject failures that are not a locked DLL
    Given the copy or directory creation fails with <failure>
    When the user runs "Inject Bridge into DCS"
    Then an error reads "Inject failed: <message>"
    And no success toast is shown

    Examples:
      | failure                              | message                        |
      | a full disk                          | ENOSPC: no space left on device |
      | a rejection that is not an Error     | access denied                  |

  @chaos
  Scenario: A stale hook and single-DLL-era artifacts from an older DCS Studio
    Given "<writeDir>\Scripts\Hooks\DcsStudio.lua" is an older version of the hook
    And "<writeDir>\Mods\tech\DcsStudio\bin\dcs_studio.dll" is still present
    And "<writeDir>\Scripts\DcsStudioMission.lua" is still present
    When the user runs "Inject Bridge into DCS"
    Then the hook is overwritten with the shipped one
    And "dcs_studio.dll", "dcs_bridge.dll" and "Scripts\DcsStudioMission.lua" are deleted
    # The old DLL binds port 25569 too: left behind it answers instead of the
    # new GUI bridge and nothing the extension does lands.

  @chaos
  Scenario: A legacy artifact that cannot be deleted does not fail the inject
    Given DCS still holds the legacy "dcs_studio.dll"
    And both current DLLs and the hook copy successfully
    When the user runs "Inject Bridge into DCS"
    Then the inject succeeds and the success toast is shown
    # Clearing yesterday's DLL is a courtesy; failing it must not report a
    # broken install when today's files landed.

  @chaos
  Scenario: A half-finished build pairs a fresh DLL with a shipped one
    Given "bridge\target\release" contains only "dcs_studio_gui.dll"
    When the user runs "Inject Bridge into DCS"
    Then the built GUI DLL and the SHIPPED mission DLL are deployed side by side
    And the toast names the odd one out: "Deploying the locally built
      dcs_studio_gui.dll from bridge\target\release — delete that folder to go
      back to the DLLs shipped with the extension."
    And the same note rides the launch toast, since launching injects too
    But the mismatch itself is not detected — neither DLL nor the hook carries
      a version the other checks, and the pair is still chosen per file, on
      existence alone
    # Selection ignores which file is NEWER, so a cargo build that failed hours
    # ago keeps deploying its last good binary. Saying which binary is going in
    # is what lets the user notice; nothing here silently picks for them.

  @chaos
  Scenario: The DLL is present but DCS cannot load it
    Given a deployed "dcs_studio_gui.dll" that fails to load (wrong architecture, missing MSVC runtime)
    When DCS starts
    Then the hook logs "load failed: <reason>" to dcs.log and returns quietly
    And no JSON-RPC server binds 25569
    And the extension shows "$(debug-disconnect) DCS: offline" with no other explanation

  @chaos
  Scenario: Neither Saved Games folder exists
    Given "dcsStudio.savedGamesPath" is empty
    And neither "Saved Games\DCS" nor "Saved Games\DCS.openbeta" exists
    When the user runs "Inject Bridge into DCS"
    Then "<home>\Saved Games\DCS" is used anyway and its directories are created
    And the toast names that folder
    # There is no "DCS is not installed" check here — a mistyped or missing
    # write dir produces a complete, unused install tree rather than an error.

  @chaos
  Scenario: The write dir is a UNC network path
    Given "dcsStudio.savedGamesPath" is "\\nas\share\Saved Games\DCS"
    When the user runs "Inject Bridge into DCS"
    Then the Windows path rules build "\\nas\share\Saved Games\DCS\Mods\tech\DcsStudio\bin" unchanged
    And a network failure surfaces as "Inject failed: <message>" rather than a silent no-op

  @chaos
  Scenario: Injecting twice in a row
    Given the bridge is already injected and DCS is not running
    When the user runs "Inject Bridge into DCS" again
    Then every file is overwritten in place
    And the success toast is shown again
    # Injection is idempotent by overwrite — a double-click cannot half-install.

Feature: Bridge ejection

  Scenario: Ejecting
    When the user runs "Eject Bridge from DCS"
    Then the deployed files (both DLLs and the hook) are removed (best-effort)
    And a toast confirms "Bridge ejected from <writeDir>." only when every one
      of them actually went

  Scenario: Automatic cleanup on shutdown
    When the extension deactivates
    Then the bridge files are ejected if DCS is not holding the DLLs

  @chaos
  Scenario: Ejecting when the files are already gone
    Given the bridge was never injected, or was ejected already
    When the user runs "Eject Bridge from DCS"
    Then every removal is attempted and none of them fail the command
    And the toast still confirms "Bridge ejected from <writeDir>."
    # Extension shutdown ejects unconditionally, so a user who never injected
    # must not see an error.

  @chaos
  Scenario: DCS holds one DLL during an eject
    Given DCS is running with the bridge loaded
    When the user runs "Eject Bridge from DCS"
    Then the hook script, the mission DLL and the legacy artifacts are still removed
    And the locked GUI DLL stays on disk
    And no success toast is shown; a warning names what survived:
      "Bridge only partly ejected from <writeDir> — dcs_studio_gui.dll could
      not be removed. Close DCS and eject again."
    # Each file is attempted independently so one that will not go does not
    # strand the others — and the ones that would not go are reported, because
    # "Bridge ejected" sends the user away believing the extension's code is
    # out of their DCS when the next start would load it again.

  @chaos
  Scenario: The hook is removed while DCS is still running
    Given DCS is running and the mission bridge has not booted yet
    When the bridge is ejected
    Then the hook script is gone for the rest of that DCS run
    And the mission bridge's boot dispatch cannot be re-driven until DCS restarts # UNVERIFIED: the hook is already loaded in memory, so its per-frame callbacks keep running; what is lost is the file DCS would read on the next start

  @chaos
  Scenario: Ejecting between an inject and a DCS start
    Given the bridge was injected but DCS has not been started since
    When the user runs "Eject Bridge from DCS"
    Then every deployed file is removed
    And the next DCS start loads no bridge at all
```
