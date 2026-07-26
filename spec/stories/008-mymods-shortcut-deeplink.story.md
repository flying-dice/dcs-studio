# 008 — Launch My Mods from the Desktop

## Story

> **As a** DCS player who treats DCS Studio as a mod manager rather than an IDE,
> **I want** a Desktop / Start Menu shortcut that opens My Mods in its own clean window,
> **so that** I can manage mods like a standalone app — no project, no folder picker, no workspace hijacked.

## Context

- Entry points: command **"DCS Studio: Add My Mods Shortcut (Desktop / Start Menu)"** (`dcs.mymods.createShortcut`) and the **"Add shortcut"** button in the My Mods panel header.
- The shortcut launches VS Code with `--new-window --open-url -- vscode://dcs-studio.dcs-studio/mymods`; the extension's URI handler routes the deep link.

```gherkin
Feature: Creating the My Mods shortcut

  Scenario: Choosing where the shortcut goes
    Given the user is on a local Windows install
    When they run "Add My Mods Shortcut (Desktop / Start Menu)"
    Then a multi-select picker titled "Add a My Mods shortcut" opens
      with the placeholder "Where should the shortcut go? It opens My Mods in its own window — no project involved."
    And "Desktop" and "Start Menu" are both pre-selected

  Scenario: Shortcut created
    When the user confirms one or both locations
    Then a "DCS Studio - My Mods.lnk" is written to each chosen location
      with the extension's icon and the description
      "Enable, update & remove your installed DCS mods"
    And a toast confirms
      "Shortcut added to <locations>. It opens My Mods in its own window."

  Scenario: Cancelling
    When the user dismisses the picker or selects nothing
    Then no shortcut is created and nothing else happens

  Scenario: Unsupported platform
    Given the session is not a local Windows install
    Then an error explains
      "My Mods shortcuts are only supported on a local Windows install."

  Scenario: Shortcut creation failure
    Given writing a shortcut fails for a location
    Then an error lists each failed location and reason:
      "Couldn't create the shortcut — <Location>: <reason>"

  @chaos
  Scenario Outline: Sessions where a shortcut cannot be created
    Given the session is <session>
    When they run "DCS Studio: Add My Mods Shortcut (Desktop / Start Menu)"
    Then no picker opens
    And an error notification shows
      "My Mods shortcuts are only supported on a local Windows install."
      with a "Report Issue" button

    Examples:
      | session                   |
      | macOS or Linux            |
      | a Remote-SSH window       |
      | a WSL window              |
      | a dev container/Codespace |

  @chaos
  Scenario: One chosen location succeeds and the other fails
    Given both "Desktop" and "Start Menu" were chosen
    And writing the Start Menu shortcut fails
    Then the error names only the failed location:
      "Couldn't create the shortcut — Start Menu: <reason>"
    And no success toast is shown for the Desktop shortcut that WAS created,
      so nothing tells the user which half worked

  @chaos
  Scenario: PowerShell cannot be started or refuses to run
    Given "powershell.exe" is missing, or blocked by execution policy
    When the user confirms a location
    Then that location is reported with the spawn failure's message,
      or with "exit <code>" when PowerShell ran but returned non-zero
    And no partially written .lnk is left claimed as successful

  @chaos
  Scenario: Adding the shortcut a second time
    When the user runs the command again with the same locations chosen
    Then the same "DCS Studio - My Mods.lnk" path is written again in each
      location, overwriting the previous one
    And no numbered duplicate is created

  @chaos
  Scenario: The icon cannot be written to global storage
    Given the extension's global storage is not writable
    When the user confirms a location
    Then the command aborts before any .lnk is written, and no shortcut appears
    And the user is told why # UNVERIFIED: the icon write is unguarded and the command is invoked fire-and-forget, so today the rejection escapes as an unhandled promise rejection with no notification at all

Feature: The mymods deep link
  vscode://dcs-studio.dcs-studio/mymods always lands in a clean,
  project-free window.

  Scenario: Deep link into an empty window
    Given the receiving VS Code window has no workspace folder open
    When the deep link fires
    Then the My Mods panel opens in that window

  Scenario: Deep link while a project is open
    Given the receiving window has a workspace folder open
    When the deep link fires
    Then the current workspace is NOT hijacked
    And a fresh empty window is spawned
    And the new window opens My Mods on activation

  Scenario: Stale hand-off protection
    Given a pending My Mods hand-off is older than 30 seconds
      or the new window has a workspace open
    When a window activates
    Then the hand-off is discarded and My Mods does not open

  Scenario: Unknown deep link paths
    When a vscode:// URI with any other path arrives
    Then it is ignored

  @chaos
  Scenario Outline: Deep links whose path is not exactly the My Mods path
    When a "vscode://dcs-studio.dcs-studio<path>" URI arrives
    Then it is ignored: no panel opens, no window is spawned
      and no hand-off is recorded

    Examples:
      | path                   |
      | /MyMods                |
      | /mymods/               |
      | /mymods/../marketplace |
      | /mymodsX               |
      | /                      |
      | (empty)                |

  @chaos
  Scenario: A deep link carrying extra query or fragment data
    When "vscode://dcs-studio.dcs-studio/mymods?repo=../../evil&x=1#frag" arrives
    Then only the URI path is inspected, so My Mods opens as normal
    And the query and fragment are ignored — nothing from them reaches
      the panel or the ledger

  @chaos
  Scenario: Two deep links fired before the first hand-off completes
    Given the receiving window has a workspace folder open
    When the shortcut is double-clicked and two deep links arrive
    Then two fresh empty windows are spawned
    And the single hand-off breadcrumb is overwritten by the second link,
      so the first empty window to activate consumes it and opens My Mods
    And the other empty window finds no breadcrumb and opens nothing

  @chaos
  Scenario: A deep link arriving before the extension has activated
    Given VS Code was launched by the shortcut with "--open-url"
    When the URI is delivered
    Then the extension activates on the "onUri" activation event
      and the handler is registered in time to receive it
```
