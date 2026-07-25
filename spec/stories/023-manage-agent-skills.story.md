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

  @chaos
  Scenario: No workspace also withdraws the install action
    Given no folder is open
    Then every card's status pill reads "No folder open"
    And no "Install into repo" button is offered
    And "View bundled" is still available, so the skill can be read

  @chaos
  Scenario: The extension ships no skills at all
    Given the packaged extension has no "skills" folder
    When the panel opens
    Then it shows "No bundled skills found."
    And activation raises no error — a packaging slip must not break the panel

  @chaos
  Scenario Outline: An installed SKILL.md whose version cannot be read
    Given the bundled skill is v1.2.0
    And the installed copy's frontmatter is <frontmatter>
    Then its installed version reads "<reads as>"
    And the card shows the status pill "<pill>"

    Examples:
      | frontmatter                     | reads as | pill             |
      | missing entirely                | 0.0.0    | Update available |
      | present but with no "version:"  | 0.0.0    | Update available |
      | never closed by a second "---"  | 0.0.0    | Update available |
      | "version: v2"                   | v2       | Update available |

  @chaos
  Scenario: A version already written with a leading "v"
    Given a skill's frontmatter declares "version: v2.0.0"
    When its card renders
    Then the version line reads "installed v2.0.0", not "installed vv2.0.0"
    And the update button reads "Update to v2.0.0"
    # The panel prefixes a "v" for display; one already in the author's
    # frontmatter is dropped rather than doubled.

  Rule: Install, update and remove are guarded appropriately

    Scenario: Installing a skill
      Given a workspace is open and the skill is not installed
      When the user clicks "Install into repo"
      Then the bundled skill folder is copied to ".claude/skills/<id>/"
      And a toast reads
        "Skill installed to <relative path> — commit it with your repo."
        with an "Open File" button

    @chaos
    Scenario: A skill is more than its SKILL.md
      Given the bundled skill folder also contains reference files
      When the user installs it
      Then the whole folder is copied into ".claude/skills/<id>/"
      And not just SKILL.md — a partial copy would install instructions
        pointing at files that were never written

    @chaos
    Scenario: The workspace is closed while the panel is open
      Given the panel is open with a card offering "Install into repo"
      When the folder is closed and the user clicks it anyway
      Then no files are written
      And an error toast reads
        "Skill install failed: Open a folder first — skills install into the workspace repo."
      And the card list is re-pushed, so the card now reads "No folder open"

    @chaos
    Scenario: The repo cannot be written to
      Given the workspace folder is read-only
      When the user clicks "Install into repo"
      Then an error toast reads "Skill install failed: <the underlying error>"
      And the card list is re-pushed, so the card still reads "Not installed"
      And no half-written skill folder is claimed as installed

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

    @chaos
    Scenario: Declining the overwrite leaves the local edits intact
      Given the installed skill has local modifications
      When the user clicks "Reset to bundled" and dismisses the modal
        without choosing "Overwrite"
      Then nothing is copied over the installed file
      And the card still reads "Installed · locally modified"

    @chaos
    Scenario: An installed skill newer than the bundled one is never "outdated"
      Given the installed SKILL.md declares a version newer than the bundled copy
      And its content differs from the bundled copy
      Then the card reads "Installed · locally modified", not "Update available"
      And the only install action offered is "Reset to bundled",
        which asks before overwriting

    Scenario: Removing a skill
      When the user clicks "Remove"
      Then a modal asks
        "Remove the \"<id>\" skill from .claude/skills/<id> in your repo?"
      And on confirm the folder is deleted to the OS trash (recoverable)

    @chaos
    Scenario: Declining removal keeps the skill
      When the user clicks "Remove" and dismisses the modal
        without choosing "Remove"
      Then the folder is left in place
      And nothing is sent to the trash

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

    @chaos
    Scenario: The nudge's "Update" cannot write to the repo
      Given the activation nudge for an outdated skill is showing
      And the repo cannot be written to
      When the user clicks "Update"
      Then the installed copy is unchanged
      And no confirmation message appears
      And an error reads "Skill install failed: <reason>" — the same
        wording the Skills panel's own Install button gives
      And the nudge is offered again on the next activation, because the
        nudged flag is only written once the offer has been dealt with

    @chaos
    Scenario: The nudge is dismissed rather than acted on
      Given the activation nudge for an outdated skill is showing
      When the user dismisses it, or opens the Skills panel instead
      Then it is marked as delivered and does not return for that
        bundled version — only a failed install earns another try

    @chaos
    Scenario: The nudge is remembered per repo, not per machine
      Given the user dismissed the nudge for v<bundled> in one repo
      When they open a different repo whose installed skill is also outdated
      Then the nudge is shown again there

    @chaos
    Scenario: Local drift is never nudged
      Given the installed skill has local edits at the same or a newer version
      When the extension activates
      Then no nudge is shown
      And the launcher row carries no badge —
        only an older installed version counts as an update

    Scenario: Sidebar badge
      Given outdated skills exist
      Then the Agent Skills launcher row shows the update count
        and the description "Skill update available"

    Scenario: Live refresh
      When skill files change on disk or the workspace changes
      Then the panel and the sidebar badge update automatically

    @chaos
    Scenario: The file changes on disk under the open panel
      Given the panel shows the skill as "Installed · up to date"
      When the file is edited outside VS Code — by hand, or by an agent
        rewriting its own SKILL.md
      Then the watcher on ".claude/skills/**" fires
      And the card re-renders as "Installed · locally modified" without a reload

    @chaos
    Scenario: The installed folder is deleted outside the editor
      Given the panel shows the skill as installed
      When ".claude/skills/<id>" is deleted from the file system
      Then the card returns to "Not installed"
      And the "Open installed" and "Remove" buttons disappear with it

    @chaos
    Scenario: The panel goes quiet once closed
      Given the Agent Skills panel has been closed
      When a skill file changes on disk
      Then nothing is posted to the closed panel, because its subscription to
        the skills library was disposed with it
      And the library's own watcher keeps running, so the sidebar badge
        still updates
```
