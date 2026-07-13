# 007 — Manage Installed Mods in My Mods

## Story

> **As a** DCS player with mods installed,
> **I want** a single panel to enable, disable, update and uninstall them — plus a nuclear clean-uninstall escape hatch,
> **so that** I control exactly what's linked into DCS at any moment, even if the extension itself breaks.

## Context

- Entry points: command **"DCS Studio: My Mods"** (`dcs.mymods.open`), the **My Mods** launcher row, and the desktop shortcut / deep link (story 008).
- *Enabled* means the unpacked files are linked into the DCS folders; *disabled* means the files stay unpacked in the data dir but no links exist.
- A regenerated `uninstall-all.bat` in the data dir removes everything without needing the extension.

```gherkin
Feature: My Mods panel
  Lists every subscribed mod with a live enabled/disabled toggle
  and per-mod actions.

  Background:
    Given the user opens the My Mods panel

  Rule: The panel shows what's installed and where

    Scenario: Panel contents
      Then the header offers "Add shortcut" and "Refresh" buttons
      And a "Data dir: <path>" line shows where mods are unpacked
      And each installed mod shows its name, repo, release tag,
        an enable/disable toggle, and a status pill:
        "<n> links" (green) when enabled or "disabled" (muted) when off

    Scenario: Empty state
      Given no mods are installed
      Then the panel shows "No mods installed yet"
        and "Browse Mods and install one — it'll appear here to enable, update, or remove."

  Rule: Enable and disable toggle the links, never the files

    Scenario: Disabling a mod
      Given a mod is enabled
      When the user switches its toggle off
      Then all its links into the DCS folders are removed
      And the unpacked files remain in the data dir
      And a toast confirms "Disabled <repo>."

    Scenario: Enabling a mod
      Given a mod is disabled
      When the user switches its toggle on
      Then links are created per the mod's [[install]] rules
      And a toast confirms "Enabled <repo>."
      And if any link fails, all links created so far are rolled back

  Rule: Updating fetches the newest release

    Scenario: A newer release exists
      When the user clicks "Update" on a mod
      Then the panel checks GitHub for the latest release
      And the mod is disabled, the new payload downloaded and unpacked,
        and re-linked if it was enabled
      And a toast confirms "Updated <repo> to <tag>."

    Scenario: Already current
      Given the installed tag equals the latest release tag
      When the user clicks "Update"
      Then a toast reports "<repo> is already up to date (<tag>)."
      And nothing is re-downloaded

    Scenario: No release found
      Given the repo has no release anymore
      Then the update fails with "No release found on GitHub."

  Rule: Per-mod utilities

    Scenario: Opening the unpacked folder
      When the user clicks the folder icon on a mod row
      Then the mod's unpacked directory opens in the OS file manager

    Scenario: Viewing on GitHub
      When the user clicks the GitHub icon
      Then the repository opens in the system browser

    Scenario: Uninstalling
      When the user clicks the trash icon
      Then links are removed, the unpacked files deleted,
        and the ledger entry dropped
      And a toast confirms "Uninstalled <repo>."

Feature: Clean uninstall escape hatch
  A self-contained batch script that removes every DCS Studio link
  and all unpacked data — usable even without the extension.

  Scenario: Revealing the script
    When the user clicks "Reveal script"
    Then "uninstall-all.bat" is revealed in the OS file manager

  Scenario: Running the clean uninstall
    When the user clicks "Run clean uninstall"
    Then a modal warns
      "Run the clean-uninstall script? This removes ALL DCS Studio mod links from your DCS folders and deletes the unpacked mod data."
    When the user confirms with "Run uninstall-all.bat"
    Then the script runs in a terminal named "DCS Studio uninstall"
    And it removes link reparse points without deleting through them,
      deletes the unpacked mod data and the subscriptions ledger,
      and ends with "Done. All DCS Studio mods have been removed."

  Scenario: The script is always current
    Given mods are installed, updated or removed
    Then the script is regenerated from the ledger on every change
```
