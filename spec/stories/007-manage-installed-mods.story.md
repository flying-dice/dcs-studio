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

    @chaos
    Scenario: The subscriptions ledger is corrupt or truncated
      Given "<dataDir>\subscriptions.json" is not valid JSON, or holds JSON
        that is not a ledger object at all
      When the user opens My Mods
      Then the unreadable file is preserved as "subscriptions.json.corrupt"
      And a warning names that file, because it is the only remaining record
        of the links still in the DCS folders
      And "uninstall-all.bat" is NOT regenerated from the empty read, so it
        still removes every link it listed before
      And the panel shows the "No mods installed yet" empty state, which the
        warning has already explained
      And the warning is shown once, not on every redraw

    @chaos
    Scenario: The ledger file is simply not there yet
      Given no mod has ever been installed
      When the user opens My Mods
      Then the empty state is shown with no warning — a missing ledger is the
        normal first run, not a failure
      And nothing is preserved as "subscriptions.json.corrupt"

    @chaos
    Scenario: A row acted on after the mod was removed elsewhere
      Given the panel still shows a mod that is no longer in the ledger
      When the user switches its toggle on
      Then it fails with "Enabled failed: Not subscribed."
      And the list is re-read either way, so the stale row disappears

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
      Then links are created per the mod's [[symlink]] rules
      And a toast confirms "Enabled <repo>."
      And if any link fails, all links created so far are rolled back

    @chaos
    Scenario: A link that cannot be removed while disabling
      Given DCS is running and holds one of the mod's links open
      When the user switches the toggle off
      Then every other link is still attempted — one failure does not stop the rest
      And it fails with "Disabled failed: <n> of <m> link(s) could not be
        removed — close DCS and try again. Still linked: <dest> (<reason>)"
      And the surviving link stays in the ledger, and therefore in
        "uninstall-all.bat", which is the escape hatch for exactly this case
      And the mod stays enabled, because a link of its is still in place
      And switching the toggle off again once DCS is closed removes what is
        left and completes the disable

    @chaos
    Scenario: Enabling a mod whose unpacked files were deleted by hand
      Given the mod's "dcs-studio.toml" is gone from its data dir
      When the user switches its toggle on
      Then it fails with "Enabled failed: <the file-not-found error>"
      And an error notification with a "Report Issue" button is shown
      And the mod stays disabled and the list is redrawn

    @chaos
    Scenario: Toggling a mod into the state it is already in
      When the user enables a mod that is already enabled
      Then nothing is linked and nothing is written to the ledger
      And the toast still confirms "Enabled <repo>."

    @chaos
    Scenario: The ledger cannot be saved after the links were created
      Given the data dir became read-only after the mod was unpacked
      When the user switches the toggle on
      Then the links have already been created in the DCS folders
      And saving the ledger fails, so the mod is still recorded as disabled
        with no links, and the mission-script aggregators are never regenerated
      And an "Enabled failed: <reason>" notification is shown
      # UNVERIFIED: nothing removes the links that were created before the save
      # failed — they are now untracked, and disable has no record to act on.

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

    @chaos
    Scenario Outline: Update cannot reach a usable release
      When the user clicks "Update" and <situation>
      Then an error notification shows "Update failed: <message>"
        with a "Report Issue" button
      And the mod is left exactly as it was — the lookup happens before
        anything is disabled or downloaded
      And the list is redrawn

      Examples:
        | situation                          | message                                                                 |
        | the repo has no release            | No release found on GitHub.                                             |
        | GitHub rate limits the lookup      | GitHub rate limit reached. Sign in to raise the limit, or wait a minute. |
        | the repo was deleted or made private | Repository <owner/repo> was not found.                                |
        | the request fails as a non-Error   | socket hang up                                                          |

    @chaos
    Scenario: The update fails after the mod was disabled
      Given an enabled mod with a newer release available
      When the update disables it, and the download or extraction then fails
      Then the mod is left DISABLED with no links, still on its old tag
      And "Update failed: <reason>" is shown with a "Report Issue" button
      And the list is redrawn so the row honestly shows "disabled"
        rather than the enabled state it had a moment earlier

    @chaos
    Scenario: The mod cannot be unlinked before the update
      Given DCS is running and holds one of the mod's links open
      When the user clicks "Update"
      Then the update stops at the disable step, before anything is downloaded,
        so files something else is still holding are never overwritten
      And "Update failed: <n> of <m> link(s) could not be removed — close DCS
        and try again. …" is shown with a "Report Issue" button
      And the mod is still on its old tag

    @chaos
    Scenario: Updating a mod that was uninstalled in another window
      Given the panel still shows a mod that is no longer in the ledger
      When the user clicks "Update" on that stale row
      Then there is no installed tag to compare against, so the latest release
        is downloaded and installed fresh
      And the mod reappears in the list as a new subscription

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

    @chaos
    Scenario: Opening the folder of a mod whose directory was deleted
      Given the mod's unpacked folder was deleted outside the extension
      When the user clicks the folder icon
      Then the recorded path is still handed to the OS file manager —
        the row acts on the ledger entry, not on what is on disk

  Rule: Entrypoints run a stranger's executable, so the path is always shown

    @chaos
    Scenario: Launching an entrypoint whose exe is missing
      Given the mod's payload no longer contains the declared exe
      When the user clicks Launch
      Then nothing is spawned, and it fails with
        "Launch failed: Executable not found: <resolved path>"
      And the row falls back out of "running", so Stop is not the only
        button left for a process that never started

    @chaos
    Scenario: An entrypoint exe declared as an absolute path
      Given "[[entrypoint]] exe" is "C:\Windows\System32\calc.exe"
      Then it is joined onto the mod's unpacked dir rather than used as an
        absolute path, resolving to "<unpackedDir>\C:\Windows\System32\calc.exe"
      And the confirmation modal names that resolved path, so the user judges
        what will actually run
      And launching fails with "Executable not found: <that path>"

    @chaos
    Scenario: An entrypoint exe that walks out of the mod folder
      Given "[[entrypoint]] exe" is "..\..\..\Windows\System32\calc.exe"
      Then the launch is refused because the exe resolves outside the mod's
        unpacked directory # UNVERIFIED: the path is joined with no containment check, so it does resolve outside; the only protection today is that the modal names the resolved absolute path and consent is required per mod + entrypoint

    @chaos
    Scenario: Declining the launch prompt
      When the user dismisses the "Launch <name> from <repo>?" modal
      Then nothing is spawned and no consent is remembered
      And the next Launch asks again

    @chaos
    Scenario: A tracked executable exits or fails to start on its own
      Given the user launched an entrypoint
      When that process exits, or spawning it errors after the fact
      Then the panel re-reads the list without the user pressing Refresh
      And the row goes back to offering Launch

    @chaos
    Scenario: Disabling or uninstalling a mod with a running executable
      Given one of the mod's entrypoints is running
      When the user disables or uninstalls the mod
      Then its executables are stopped first, killing the process tree,
        before any link is removed

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

  @chaos
  Scenario: Dismissing the clean-uninstall warning
    When the user dismisses the modal instead of confirming
    Then no terminal is created and nothing is removed

  @chaos
  Scenario: The data dir cannot be written
    Given "<dataDir>" is read-only, or on a drive that is no longer mounted
    When the panel is drawn
    Then regenerating "uninstall-all.bat" fails silently — a read-only data dir
      must never break a subscription write
    And "Reveal script" still reveals the path, with no file at it

  @chaos
  Scenario: A link destination containing a double quote
    Given a mod link destination contains a '"' character
    Then the generated script strips the quote when quoting the path,
      so the batch file cannot be broken out of
```
