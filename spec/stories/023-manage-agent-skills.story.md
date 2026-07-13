# 023 — Manage Agent Skills for the Repo

## Story

> **As a** mod author using AI coding agents,
> **I want** to install the bundled DCS Studio skill file into my repo, keep it updated, and see when it drifts,
> **so that** every contributor's agent knows how to write DCS mods and drive DCS Studio.

## Context

- Entry points: command **"DCS Studio: Manage Agent Skills"** (`dcs.skills.open`), the **Agent Skills** launcher row (badged when updates exist), and activation-time update nudges.
- Skills are `SKILL.md` files bundled with the extension (currently one: `dcs-studio`, covering the manifest format, environments, sanitization, templates, bridge/debugger and publishing). Installing copies the skill into `.claude/skills/<id>/` in the workspace so it can be committed.

```gherkin
Feature: Agent Skills panel

  Scenario: Panel overview
    When the user opens "Manage Agent Skills"
    Then one card per bundled skill shows its name, description and a status pill:
      | Status pill                    | Meaning                                  |
      | No folder open                 | no workspace to install into             |
      | Not installed                  | not yet in the repo                      |
      | Installed · up to date         | identical to the bundled copy            |
      | Update available               | bundled version is newer                 |
      | Installed · locally modified   | content differs from the bundled version |

  Scenario: No workspace
    Given no folder is open
    Then the panel warns "Open a folder to install skills into a repo."

  Rule: Install, update and remove are guarded appropriately

    Scenario: Installing a skill
      Given a workspace is open and the skill is not installed
      When the user clicks "Install into repo"
      Then the bundled skill folder is copied to ".claude/skills/<id>/"
      And a toast reads
        "Skill installed to <relative path> — commit it with your repo."
        with an "Open File" button

    Scenario: Updating an outdated skill
      Given the installed skill is older than the bundled one
      When the user clicks "Update to v<bundled>"
      Then the installed copy is replaced without prompting

    Scenario: Local edits are never silently overwritten
      Given the installed skill has local modifications
      When the user installs or resets it
      Then a modal asks
        "The installed \"<id>\" skill has local edits. Overwrite them with the bundled v<version>?"
      And only "Overwrite" proceeds

    Scenario: Removing a skill
      When the user clicks "Remove"
      Then a modal asks
        "Remove the \"<id>\" skill from .claude/skills/<id> in your repo?"
      And on confirm the folder is deleted to the OS trash (recoverable)

    Scenario: Viewing skill contents
      Then "Open installed" opens the repo's copy
      And "View bundled" opens the extension's bundled copy read-only

  Rule: Updates are surfaced without being opened

    Scenario: Activation nudge
      Given an installed skill is outdated and not yet nudged for this version
      When the extension activates
      Then a message reads
        "The \"<name>\" agent skill in this repo is outdated (v<installed> installed, v<bundled> bundled)."
        with "Update" and "Manage Skills" buttons
      And "Update" installs and confirms
        "\"<name>\" skill updated to v<bundled> — commit the change."
      And the nudge does not repeat for the same bundled version

    Scenario: Sidebar badge
      Given outdated skills exist
      Then the Agent Skills launcher row shows the update count
        and the description "Skill update available"

    Scenario: Live refresh
      When skill files change on disk or the workspace changes
      Then the panel and the sidebar badge update automatically
```
