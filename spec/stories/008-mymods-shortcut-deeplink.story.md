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
```
