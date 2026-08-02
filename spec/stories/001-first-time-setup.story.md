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

    @chaos
    Scenario: Dismissing the nudge still spends it
      Given neither "dcsStudio.savedGamesPath" nor "dcsStudio.gameInstallPath" is set
      And the user has never been prompted before
      When the extension activates
      And the user dismisses the message without clicking "Set DCS Paths"
      Then the "DCS Setup" panel does not open
      And no nudge is shown on any later activation, because the prompted flag
        is written before the message is shown

    @chaos
    Scenario Outline: Only the userdata and install paths suppress the nudge
      Given the only DCS Studio setting with a non-blank value is "<setting>"
      And the user has never been prompted before
      When the extension activates
      Then the nudge is <shown>

      Examples:
        | setting                   | shown     |
        | dcsStudio.savedGamesPath  | not shown |
        | dcsStudio.gameInstallPath | not shown |
        | dcsStudio.dataDir         | shown     |
        | dcsStudio.sevenZipPath    | shown     |

    @chaos
    Scenario: A whitespace-only path counts as unconfigured
      Given "dcsStudio.savedGamesPath" is "   " and "dcsStudio.gameInstallPath" is "   "
      And the user has never been prompted before
      When the extension activates
      Then the nudge is shown, because both values are trimmed before they are tested

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

    @chaos
    Scenario: The Saved Games folder does not exist at all
      Given the user's profile has no "Saved Games" folder,
        or it cannot be read
      When the panel detects candidates
      Then the userdata card lists no candidates
      And it shows
        "Nothing detected automatically — use Browse to point at the folder."
      And no error notification is raised — a fresh machine is not a failure

    @chaos
    Scenario Outline: Entries in Saved Games that are not DCS write dirs
      Given the user's profile has a "Saved Games\<entry>" <kind>
      When the panel detects candidates
      Then it is not offered as a userdata candidate

      Examples:
        | entry          | kind   |
        | DCSX           | folder |
        | dcs            | folder |
        | Diablo IV      | folder |
        | DCS.stray-file | file   |

    @chaos
    Scenario: A registry entry pointing at an install that is gone
      Given an Eagle Dynamics registry key holds an empty "Path" value,
        or names a folder that has since been deleted
      When the panel detects candidates
      Then that entry is dropped entirely
      And it is not listed as an invalid candidate the user could pick

    @chaos
    Scenario: The same install is registered more than once
      Given the same folder appears under both the HKCU and HKLM Eagle Dynamics
        keys, differing only in letter case
      When the panel detects candidates
      Then it is listed once
      And the name from the first (registry) hit is the one shown

    @chaos
    Scenario: A configured path that differs only in case still matches
      Given "dcsStudio.savedGamesPath" is "c:\users\pilot\saved games\dcs"
      And "C:\Users\pilot\Saved Games\DCS" was detected as a candidate
      When the panel opens
      Then that candidate is shown as the selected one
      And the field shows "✔ has Config"

    @chaos
    Scenario: Re-detect discards unsaved edits
      Given the user has typed a path into a card but has not clicked "Save DCS paths"
      When the user clicks "Re-detect"
      Then every field is re-seeded from the saved settings
      And the typed path is lost without warning

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

    @chaos
    Scenario: A browsed 7z.exe never lands in the DCS install field
      Given the "DCS installation" field already holds a path
      When the user clicks "Browse…" on the 7-Zip card and picks "E:\Tools\7z.exe"
      Then the 7-Zip field holds "E:\Tools\7z.exe"
      And the "DCS installation" field is unchanged

    @chaos
    Scenario: Cancelling the picker changes nothing
      When the user clicks "Browse…" on any card and cancels the native dialog
      Then no path is sent back to the panel
      And that card's field keeps its previous value

    @chaos
    Scenario Outline: A browsed path that fails its role probe is still accepted
      When the user browses to <path> for the <card> card
      Then the path is placed in that card's field
      And a red ⚠ validity line is shown in the role's own words —
        "no Config folder — run DCS once, or pick another folder" for userdata,
        "no bin\DCS.exe in this folder" for the installation
        (only a hand-typed path shows no line, because it was never probed;
        the data-dir and 7-Zip cards never show a validity line at all)
      And "Save DCS paths" stays available

      Examples:
        | card             | path                                              |
        | DCS userdata     | a folder with no "Config" subfolder               |
        | DCS installation | a folder with no "bin\DCS.exe"                    |
        | DCS userdata     | "\\fileserver\share\DCS" on a share that is down  |

    @chaos
    Scenario: A path Windows refuses to probe
      When the user browses to a path the OS rejects at the syscall level —
        illegal characters, or longer than MAX_PATH
      Then the panel treats it as invalid rather than throwing
      And the panel stays usable

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

    @chaos
    Scenario: Clearing a path saves the empty string
      Given "dcsStudio.sevenZipPath" currently holds a value
      When the user empties the 7-Zip field and clicks "Save DCS paths"
      Then "" is written to "dcsStudio.sevenZipPath" in global settings
      And 7-Zip auto-detection resumes, because an empty setting means
        "look on PATH and under Program Files\7-Zip"

    @chaos
    Scenario: Saving with every field empty clears all four settings
      When the user clicks "Save DCS paths" with nothing filled in
      Then all four settings are written as ""
      And the old values do not survive, so a clear is never silently ignored

    @chaos
    Scenario: Paths are trimmed before they are saved
      Given the user pastes "  D:\SG\DCS  " into the userdata field
      When the user clicks "Save DCS paths"
      Then "D:\SG\DCS" is saved, because a trailing space is invisible in the UI
        but breaks every path join downstream
      And a field holding only whitespace is saved as ""

    @chaos
    Scenario: Paths are always user settings, never workspace settings
      Given a folder is open in the editor
      When the user clicks "Save DCS paths"
      Then all four values are written with the Global configuration target
      And no workspace-level override is created, because these paths describe
        the machine's DCS install rather than the project

    @chaos
    Scenario: Opening Setup twice reveals the panel without re-detecting
      Given the "DCS Setup" panel is already open
      When the user runs "DCS Studio: Set DCS Paths…" again
      Then the existing panel is revealed
      And no second panel opens
      And detection does not re-run — "Re-detect" is the only way to refresh it
```
