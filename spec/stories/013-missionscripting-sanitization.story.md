# 013 — Manage MissionScripting.lua Sanitization

## Story

> **As a** scripter or bridge user,
> **I want** safe one-click desanitize / re-sanitize / restore of DCS's `MissionScripting.lua`, with an automatic backup,
> **so that** mission scripts and the debugger get the full Lua environment when I'm developing, and DCS returns to stock lockdown when I'm not.

## Context

- Operates on the real file at `<gameInstall>\Scripts\MissionScripting.lua`. Managed items: `os`, `io`, `lfs`, `require`, `loadlib`, `package`.
- Entry points: commands **"Open MissionScripting.lua"**, **"Desanitize MissionScripting.lua"**, **"Re-sanitize MissionScripting.lua"**, **"Restore MissionScripting.lua from backup"**; the **MissionScripting** launcher row; unlock/lock editor-title icons (Restore in the overflow menu) when the file is the active editor.
- Desanitize comments the lockdown lines out (`-- ` prefix); re-sanitize removes the prefix. Quote style, indentation and line endings are preserved; both operations are idempotent.

```gherkin
Feature: MissionScripting.lua management

  Rule: The user is guided when preconditions are missing

    Scenario: No install path configured
      Given "dcsStudio.gameInstallPath" is not set
      When the user runs any MissionScripting command
      Then a message explains
        "Set your DCS installation path to manage MissionScripting.lua."
      And offers a "Set DCS Paths" button that opens the Setup panel

    Scenario: File missing
      Given the configured install has no MissionScripting.lua
      Then an error reads
        "MissionScripting.lua not found at <path>. Check your DCS install path in Settings."

    Scenario: Access denied under Program Files
      Given writing the file is denied
      Then an error reads
        "Access denied — MissionScripting.lua is under Program Files. Run VS Code as administrator, or edit it manually."

    Scenario: Unsaved edits block changes
      Given the file is open with unsaved changes
      When the user desanitizes or re-sanitizes
      Then a warning reads
        "MissionScripting.lua has unsaved changes. Save or close it first, then try again."

    @chaos
    Scenario: The "Set DCS Paths" offer is dismissed
      Given "dcsStudio.gameInstallPath" is not set
      When the user runs any MissionScripting command
      And dismisses the message without choosing "Set DCS Paths"
      Then the Setup panel is NOT opened
      And nothing is read from or written to disk

    @chaos
    Scenario Outline: Every mutating command refuses to write behind an unsaved buffer
      Given MissionScripting.lua is open in an editor with unsaved changes
      When the user runs "<command>"
      Then a warning reads
        "MissionScripting.lua has unsaved changes. Save or close it first, then try again."
      And the file is not written and no backup is taken
      # Saving that stale buffer afterwards would silently reverse the change:
      # on a desanitize it re-locks the sandbox, on a restore it puts the
      # mangled file straight back.

      Examples:
        | command                                                   |
        | Desanitize MissionScripting.lua                           |
        | Re-sanitize MissionScripting.lua                          |
        | Restore MissionScripting.lua from backup                  |
        | Install mod mission-script hooks in MissionScripting.lua  |
        | Remove mod mission-script hooks from MissionScripting.lua |

    @chaos
    Scenario: The editor opened the file under different path casing
      Given the configured path is "D:\DCS World\Scripts\MissionScripting.lua"
      And an editor holds "d:\dcs world\scripts\missionscripting.lua" with unsaved changes
      When the user desanitizes
      Then the unsaved-changes guard still fires
      # Windows paths are case-insensitive; a case-sensitive compare would miss
      # the very buffer the guard exists for.

    @chaos
    Scenario: The file is read-only for a reason other than Program Files
      Given the write fails with EPERM or EACCES
      When the user desanitizes
      Then the error reads
        "Access denied — MissionScripting.lua is under Program Files. Run VS Code as administrator, or edit it manually."
      And no success toast is shown
      # Every EPERM/EACCES gets this wording, including a read-only attribute or
      # an antivirus block outside Program Files.

    @chaos
    Scenario: Something else holds the file open
      Given the write fails with EBUSY
      When the user desanitizes
      Then the error is the underlying message verbatim, with no Program Files hint
      And no success toast is shown

    @chaos
    Scenario: The file disappears between the existence check and the write
      Given MissionScripting.lua exists when the command starts
      But a DCS updater removes it before the read
      When the user desanitizes
      Then the ENOENT message is surfaced as the error
      And nothing is written and no backup is taken

  Rule: Opening informs; editing never runs/debug buttons

    Scenario: Opening a sanitized file
      When the user runs "Open MissionScripting.lua"
      Then the real file opens in an editor
      And an info message reads
        "MissionScripting.lua is sanitized (<locked items> locked). Use \"Desanitize\" to unlock for the bridge/mods."

    Scenario: Editor-title actions
      Given MissionScripting.lua is the active editor
      Then the title bar shows unlock (Desanitize) and lock (Re-sanitize) icons
      And "Restore from backup" sits in the overflow menu
      And the Lua run/debug buttons are NOT shown on this file

  Rule: Changes are backed up and reversible

    Scenario: First change creates a backup
      Given no backup exists yet
      When the user desanitizes or re-sanitizes for the first time
      Then a pristine copy is saved as "MissionScripting.lua.dcsstudio.bak"
        before anything is written

    Scenario: Desanitizing
      When the user runs "Desanitize MissionScripting.lua"
      Then every lockdown line is commented out, preserving formatting
      And the open editor refreshes to match disk
      And a toast confirms
        "Desanitized MissionScripting.lua — os/io/lfs/require/package are available. (backup: MissionScripting.lua.dcsstudio.bak)"

    Scenario: Re-sanitizing
      When the user runs "Re-sanitize MissionScripting.lua"
      Then the comment prefixes are removed, restoring DCS's default lockdown
      And a toast confirms
        "Re-sanitized MissionScripting.lua — DCS's default lockdown restored. (backup: …)"

    Scenario: Restoring from backup
      Given a DCS update or manual edit left the file in doubt
      When the user runs "Restore MissionScripting.lua from backup"
      Then the backup is copied back over the live file
      And a toast confirms "Restored MissionScripting.lua from the backup."

    Scenario: Restore without a backup
      Given no backup file exists
      Then the restore fails with "No backup found."

    Scenario: Idempotence
      Given the file is already in the requested state
      When the user repeats the operation
      Then lines already in the desired state are left untouched

    @chaos
    Scenario: Repeating a no-op change still names a backup that was never made
      Given the file is already fully desanitized
      And no "MissionScripting.lua.dcsstudio.bak" exists
      When the user runs "Desanitize MissionScripting.lua"
      Then nothing is written and no backup is created
      But the toast still ends "(backup: MissionScripting.lua.dcsstudio.bak)"
      # The backup is snapshotted only when a line actually changes, while the
      # toast names it unconditionally — so it can promise a file that is not there.

    @chaos
    Scenario: A DCS update rewrites the file after the backup was taken
      Given a backup was snapshotted from an earlier version of MissionScripting.lua
      And a DCS update has since replaced the live file
      When the user desanitizes the updated file
      Then the existing backup is left untouched — only the first change ever snapshots
      And a later "Restore MissionScripting.lua from backup" puts the PRE-UPDATE
        file back, not the version DCS just shipped

    @chaos
    Scenario: The first change is snapshotted from a file another tool already edited
      Given a third-party mod manager has already commented out some lockdown lines
      And no backup exists yet
      When the user desanitizes
      Then the backup is a copy of that half-edited file, not of DCS's shipped original
      And "Restore MissionScripting.lua from backup" can only return to that state

    @chaos
    Scenario: The backup itself is corrupt or truncated
      Given "MissionScripting.lua.dcsstudio.bak" contains a truncated or mangled file
      When the user runs "Restore MissionScripting.lua from backup"
      Then the backup is copied over the live file with no validation of its contents
      And the toast still confirms "Restored MissionScripting.lua from the backup."
      And the reported item states simply reflect whatever the backup contained

    @chaos
    Scenario: The backup was deleted since it was taken
      Given "MissionScripting.lua.dcsstudio.bak" has been deleted
      When the user runs "Restore MissionScripting.lua from backup"
      Then an error reads "No backup found."
      And the live file is untouched

  Rule: A file someone else already edited is repaired, never doubled

    @chaos
    Scenario: Only half the lockdown block is commented out
      Given "os" and "io" are already commented out
      And "lfs", "require", "loadlib" and "package" are still active
      When the user runs "Desanitize MissionScripting.lua"
      Then only the still-active lines gain a "-- " prefix
      And the already-commented lines are left byte-for-byte
      And a single toast reports the whole operation

    @chaos
    Scenario: An item appears twice, once active and once commented
      Given the file contains both "sanitizeModule('os')" and "-- sanitizeModule('os')"
      Then the status reports "os" as present and sanitized
      # Any active line makes the item count as locked, so a leftover duplicate
      # cannot be mistaken for an unlocked environment.
      When the user desanitizes
      Then the active line is commented and the already-commented one is left alone

    @chaos
    Scenario Outline: A lockdown statement written in an unrecognised form is left alone
      Given a line reads "<line>"
      When the user desanitizes or re-sanitizes
      Then the line is not treated as a managed lockdown line and is written back unchanged
      And the item is reported absent, so nothing claims to have unlocked it

      Examples:
        | line                  |
        | sanitizeModule(os)    |
        | _G[require] = nil     |
        | _G['require'] = require |
        | sanitizeModule('os'   |
        | cleanModule('os')     |

    @chaos
    Scenario: The sanitizeModule helper's own body is never toggled
      Given the file defines "local function sanitizeModule(name)" whose body is "_G[name] = nil"
      When the user desanitizes
      Then that unquoted line is left untouched
      # Commenting it out would break the helper for every other DCS mod.

    @chaos
    Scenario Outline: Tolerated spellings of the managed lines
      Given the lockdown line is written as "<line>"
      When the user toggles it
      Then it is recognised and toggled, preserving its indentation and quote style

      Examples:
        | line                    |
        | sanitizeModule('os')    |
        | sanitizeModule("os")    |
        |   sanitizeModule ( 'os' )   |
        | _G [ "require" ] =  nil |
        | --sanitizeModule('os')  |
        | -- sanitizeModule('os') |

  Rule: The file's bytes survive the edit

    @chaos
    Scenario: Mixed line endings are normalised
      Given the file contains at least one CRLF ending alongside LF-only lines
      When the user desanitizes
      Then every line ending in the written file is CRLF
      # The EOL is chosen once for the whole file — any CRLF present wins — so a
      # mixed file comes back consistent rather than mixed.

    @chaos
    Scenario: An all-LF file stays all-LF
      Given the file uses LF endings throughout
      When the user desanitizes
      Then no CR characters are introduced

    @chaos
    Scenario: The file is not UTF-8
      Given MissionScripting.lua has been saved as UTF-16 or with a byte-order mark
      When the user desanitizes
      Then the toggle either leaves the file byte-identical or refuses with a readable error # UNVERIFIED: readText/writeText are hard-coded to "utf8" with no BOM or encoding detection, and no test covers a non-UTF-8 file — a UTF-16 file would most likely be read as mojibake, match no lockdown line, and be written back mangled

  Rule: The editor never disagrees with disk

    @chaos
    Scenario: The visible editor is left alone when the write fails
      Given MissionScripting.lua is open, saved, and visible
      And the write fails
      When the user desanitizes
      Then no revert is issued against the editor
      And no success toast is shown
      And the error names the failure

    @chaos
    Scenario: The file is open in a background tab
      Given MissionScripting.lua is open but not in a visible editor group
      When the user desanitizes
      Then the write succeeds and no revert is issued
      # VS Code reloads the unmodified document on its own when it is next shown.

  Rule: Toggling while DCS is running only affects the next mission

    @chaos
    Scenario: Desanitizing mid-mission
      Given DCS is running with a mission loaded
      When the user runs "Desanitize MissionScripting.lua"
      Then the file is written normally — DCS does not hold it open
      And the running mission keeps the sandbox it started with, so the mission
        bridge on port 25570 stays unreachable until the mission is restarted # UNVERIFIED: DCS reads MissionScripting.lua when the mission scripting state is created; nothing in the extension observes or asserts this
```
