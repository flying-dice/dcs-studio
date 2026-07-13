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
```
