# 001 — First-Time Setup: Point DCS Studio at the Sim

## Story

> **As a** DCS World player setting up DCS Studio for the first time,
> **I want** to point the extension at my DCS folders (Saved Games, game install, data dir, 7-Zip) with auto-detection doing the heavy lifting,
> **so that** mod installs, bridge injection, DCS launch and the Lua console all know where my sim lives.

## Context

- Entry points: command **"DCS Studio: Set DCS Paths…"** (`dcs.setup.open`), the **Settings** row ("DCS paths & options") in the launcher sidebar, "Open Settings" buttons inside Documentation pages, and a one-time first-run nudge on activation.
- All four values are saved to **user (Global) settings**: `dcsStudio.savedGamesPath`, `dcsStudio.gameInstallPath`, `dcsStudio.dataDir`, `dcsStudio.sevenZipPath`.
- Validation is advisory — the user may save any path; downstream features surface their own errors.

```gherkin
Feature: DCS path setup
  The Setup panel lets the user configure the four machine-specific paths
  DCS Studio depends on, with automatic candidate detection and native
  Browse pickers.

  Background:
    Given the DCS Studio extension is installed and activated

  Rule: The user is nudged exactly once to configure paths

    Scenario: First activation with no paths configured
      Given neither "dcsStudio.savedGamesPath" nor "dcsStudio.gameInstallPath" is set
      And the user has never been prompted before
      When the extension activates
      Then an information message appears:
        "Set your DCS folders to enable inject, launch and the Lua console."
      And it offers a "Set DCS Paths" button
      When the user clicks "Set DCS Paths"
      Then the "DCS Setup" panel opens

    Scenario: The nudge never repeats
      Given the user was shown the first-run nudge in a previous session
      When the extension activates again with no paths configured
      Then no nudge is shown

  Rule: The Setup panel auto-detects likely folders

    Scenario: Opening the Setup panel
      When the user runs "DCS Studio: Set DCS Paths…"
      Then a "DCS Setup" panel opens with four cards:
        | Card                           | Setting                    |
        | DCS userdata (Saved Games)     | dcsStudio.savedGamesPath   |
        | DCS installation               | dcsStudio.gameInstallPath  |
        | DCS Studio data dir            | dcsStudio.dataDir          |
        | 7-Zip                          | dcsStudio.sevenZipPath     |
      And each card shows a text input, a "Browse…" button where relevant,
        and a list of detected candidates

    Scenario: Saved Games detection
      Given the user's profile has folders "Saved Games\DCS" and "Saved Games\DCS.openbeta"
      When the panel detects candidates
      Then both folders are listed, plain "DCS" first
      And a candidate containing a "Config" subfolder shows the pill "has Config"
      And a candidate without one shows "no Config yet — run DCS once"

    Scenario: Game install detection
      Given DCS World is registered under the Eagle Dynamics registry keys
        or installed under a "Program Files\Eagle Dynamics" folder
      When the panel detects candidates
      Then each candidate is validated by the presence of "bin\DCS.exe"
      And shows "bin\DCS.exe found" or "no bin\DCS.exe" accordingly

    Scenario: 7-Zip detection status
      Given 7-Zip is installed on PATH or under "Program Files\7-Zip"
      Then the 7-Zip card shows "✔ Detected: <path>"
      But if 7-Zip cannot be found
      Then the card shows "⚠ 7z not found — set it here or install 7-Zip"

    Scenario: Nothing detected
      Given no candidate folders exist for a card
      Then that card shows
        "Nothing detected automatically — use Browse to point at the folder."

    Scenario: Re-running detection
      When the user clicks the "Re-detect" button in the panel header
      Then all candidate lists and detection statuses refresh

  Rule: Browsing uses native pickers with contextual labels

    Scenario Outline: Browsing for a path
      When the user clicks "Browse…" on the <card> card
      Then a native <picker> opens with the confirm label "<label>"

      Examples:
        | card             | picker        | label                |
        | DCS userdata     | folder picker | Use as DCS userdata  |
        | DCS installation | folder picker | Use as DCS install   |
        | data dir         | folder picker | Use as data dir      |
        | 7-Zip            | .exe picker   | Use this 7z.exe      |

  Rule: Saving writes global settings and confirms

    Scenario: Saving paths
      Given the user has filled in one or more path fields
      When the user clicks "Save DCS paths"
      Then all four values are written to the user's global settings
      And an information toast appears: "DCS paths saved."
      And an inline "Saved ✓" note shows in the panel for two seconds

    Scenario: Saving an invalid path is allowed
      Given the typed install path has no "bin\DCS.exe"
      When the user clicks "Save DCS paths"
      Then the value is saved anyway
      And features that need the path surface their own errors later
```
