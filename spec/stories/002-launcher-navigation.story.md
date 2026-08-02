# 002 — Launcher Sidebar, Status Bar & Live State

## Story

> **As a** DCS Studio user,
> **I want** a single home in the VS Code activity bar that shows every feature, adapts to my project, and reflects the live sim connection,
> **so that** I can reach any part of the tool in one click and always know whether DCS is online.

## Context

- The **DCS Studio** activity-bar container hosts one webview view (`dcsStudio.launcher`) rendering navigation rows.
- Two status bar items exist: **"$(package) DCS Marketplace"** (always) and a live bridge status item. The bridge item's click routes through a dispatcher: offline it offers the launch entrypoint (story 015) alongside the console and inject; online it opens the console directly.
- The view adapts to workspace state: manifest presence toggles author rows; skill updates badge the Agent Skills row; bridge status drives the footer.

```gherkin
Feature: Launcher sidebar navigation
  A persistent navigation home listing every DCS Studio capability,
  with rows that adapt to the open workspace.

  Background:
    Given the extension is activated
    And the user clicks the "DCS Studio" icon in the activity bar

  Rule: Every capability is one click away

    Scenario: Default rows for a workspace without a manifest
      Given the open workspace has no "dcs-studio.toml"
      Then the launcher shows main rows:
        | Row              | Description                              | Command              |
        | Browse Mods      | Discover & install community mods        | dcs.marketplace.open |
        | My Mods          | Enable, update & remove installed mods   | dcs.mymods.open      |
        | Create a Mod     | Start a new project from a template      | dcs.manifest.author  |
        | DCS Console      | Run Lua in the live sim                  | dcs.bridge.console   |
        | DCS Log          | Tail dcs.log with filters                | dcs.log.open         |
        | MissionScripting | Sanitization toggle                      | dcs.mission.open     |
        | Agent Skills     | AI skill files for your repo             | dcs.skills.open      |
      And footer rows:
        | Documentation | Guides for every feature | dcs.docs.open  |
        | Settings      | DCS paths & options      | dcs.setup.open |
      And the "Publish Mod" row is hidden

    Scenario: Rows adapt when the project has a manifest
      Given the open workspace contains a "dcs-studio.toml"
      Then the "Create a Mod" row is relabelled "Edit Project"
        with description "Open the dcs-studio.toml editor"
      And a "Publish Mod" row appears
        with description "Preflight, share to GitHub & create a release"

    Scenario: Manifest changes are reflected live
      Given the launcher is visible
      When the user creates or deletes "dcs-studio.toml" in the workspace
      Then the Create/Edit and Publish rows update without a reload

    Scenario: Clicking a row runs its command
      When the user clicks any row
      Then the row highlights with an accent bar
      And the corresponding command executes

    @chaos
    Scenario: No folder is open at all
      Given the editor has no workspace folder
      Then the launcher still renders every row
      And the "Publish Mod" row stays hidden
      And no file watcher is created, because there is nothing to watch

    @chaos
    Scenario: The manifest vanishes while the launcher is visible
      Given the open workspace contains a "dcs-studio.toml"
      And the launcher shows "Edit Project" and a "Publish Mod" row
      When the file is deleted outside the editor
      Then the row reverts to "Create a Mod"
        with description "Start a new project from a template"
      And the "Publish Mod" row is hidden again

    @chaos
    Scenario: The open folder is swapped for another
      Given the launcher is watching the current workspace folder
      When the user opens a different folder
      Then the previous folder's watcher is disposed rather than left reporting
        on a repo that is no longer open
      And a watcher is created for the new folder
      And the rows are recomputed for it

    @chaos
    Scenario: Something named dcs-studio.toml that is not a manifest
      Given the workspace root holds a directory named "dcs-studio.toml"
      Then the launcher shows "Edit Project" and reveals the "Publish Mod" row
        # UNVERIFIED: no test covers this — presence is decided by a bare stat
        # that never inspects the entry's type, so a directory reads as a manifest

  Rule: The sidebar never acts on a view that has gone away

    @chaos
    Scenario: A live signal arrives after the view is disposed
      Given the launcher view has been closed
      When the bridge reports a status change, or the skills library announces one
      Then nothing is posted to the dead webview
      And no unhandled error is raised

    @chaos
    Scenario: Every subscription is torn down with the view
      When the launcher view is disposed
      Then the bridge status subscription, the skills subscription and every
        file watcher it created are disposed
      And nothing is left running across an extension reload

  Rule: The Agent Skills row advertises pending updates

    Scenario: A newer bundled skill exists
      Given an installed agent skill is older than the bundled version
      Then the "Agent Skills" row shows a count badge
      And its description reads "Skill update available"

    @chaos
    Scenario: The badge clears once the last update is applied
      Given the "Agent Skills" row shows a badge of 1
      When the skill is updated in the repo
      Then the badge is hidden
      And the description reverts to "AI skill files for your repo"

  Rule: The footer mirrors the live bridge state

    Scenario Outline: Bridge status footer
      Given the in-sim bridge is <bridge-state>
      Then the footer shows a <dot> dot and the text "<label>"

      Examples:
        | bridge-state                    | dot    | label           |
        | unreachable                     | grey   | Bridge offline  |
        | connected with no mission       | yellow | At menu         |
        | connected with a mission running | green  | Mission running |

    Scenario: Mission time readout
      Given a mission is running
      Then the footer also shows the sim time as "t <N>s"

    @chaos
    Scenario: DCS quits mid-mission
      Given the footer shows a green dot, "Mission running" and "t 213s"
      When both bridges drop
      Then the dot returns to grey and the label to "Bridge offline"
      And the sim time readout is cleared — a stale "t 213s" under an offline
        dot would read as a live mission

    @chaos
    Scenario Outline: Connected before the sim clock has reported
      Given a bridge is connected and the reported sim time is <time>
      Then the footer shows a yellow dot and "At menu"
      And no "t <N>s" readout is shown

      Examples:
        | time    |
        | absent  |
        | null    |
        | 0       |

    @chaos
    Scenario: Only the mission bridge is up
      Given the GUI bridge is unreachable
      And the mission bridge reports connected with a sim time of 87s
      Then the footer reads "Mission running" and "t 87s"
      And the time comes from the mission bridge's own clock, because the footer
        treats either bridge being up as connected

Feature: Status bar entry points
  Always-visible shortcuts into the storefront and the Lua console.

  Scenario: Marketplace status bar item
    Then the status bar shows "$(package) DCS Marketplace"
      with tooltip "Browse community mods for DCS World"
    When the user clicks it
    Then the Marketplace opens

  Scenario Outline: Bridge status bar item
    Given the bridge is <state>
    Then the status bar shows "<text>"
    When the user clicks it
    Then "<click behavior>"

    Examples:
      | state                | text                             | click behavior                                                          |
      | offline              | $(debug-disconnect) DCS: offline | a quick pick offers Launch DCS (with bridge) / Open Lua Console / Inject Bridge |
      | connected, at menu   | $(plug) DCS: at menu             | the Lua console opens directly                                          |
      | mission running (N s) | $(rocket) DCS: mission <N>s      | the Lua console opens directly                                          |
      | stalled (connected, callbacks not running) | $(debug-pause) DCS: sim idle | the Lua console opens directly                    |

  Scenario: The stalled state pre-empts the other connected states
    Given a bridge socket is up but DCS is not draining the queue
      (paused, a briefing screen, or held at a breakpoint)
    Then the status bar shows "$(debug-pause) DCS: sim idle" with the sim
      clock deliberately suppressed
    And this branch is checked before "at menu", "mission <N>s" and
      "$(warning) DCS: mission (no mission bridge)"
    # The launcher footer is unaffected — it only receives connected/dcsTime.

  Scenario: Offline click routes to the launch entrypoint (story 015)
    Given the GUI bridge is not connected
    When the user clicks the bridge status bar item and picks "Launch DCS (with bridge)"
    Then "dcs.bridge.launch" runs (see story 015 for its full behavior)

  @chaos
  Scenario: A mission is running but the mission bridge cannot boot
    Given the GUI bridge is connected and reports a sim time above zero
    And the mission bridge is unreachable, because MissionScripting.lua is sanitized
    Then the status bar shows "$(warning) DCS: mission (no mission bridge)"
    And its tooltip names "DCS Studio: Desanitize MissionScripting.lua"
    When the user clicks it
    Then the Lua console opens directly, because the GUI bridge is up

  @chaos
  Scenario: The mission bridge reports connected while the GUI bridge is down
    Given the GUI bridge is unreachable
    And the mission bridge transiently reports connected
    When the user clicks the bridge status bar item
    Then the offline quick pick is offered, not the console —
      "offline" is deliberately the GUI bridge alone

  @chaos
  Scenario Outline: A mission whose clock has not ticked through
    Given the mission bridge is connected and its sim time is <time>
    Then the status bar shows "$(rocket) DCS: mission" with no time suffix

    Examples:
      | time |
      | null |
      | 0    |

Feature: Error reporting escape hatch
  Every error notification raised through the extension's error helper
  carries a "Report Issue" action.

  Scenario: Reporting a failure
    Given an operation fails and an error notification is shown
    When the user clicks "Report Issue"
    Then the browser opens a pre-filled GitHub issue
      including the message, a truncated stack trace,
      and extension / VS Code / OS version info

  @chaos
  Scenario: Reporting a failure that carried no error object
    Given an error notification was raised without an underlying Error
    When the user clicks "Report Issue"
    Then the issue body omits the "### Stack" section entirely
    And still carries the message and the environment block

  @chaos
  Scenario: A failure with a very large stack
    Given the error's stack runs to thousands of characters
    When the user clicks "Report Issue"
    Then the stack is cut at 1500 characters and marked "… (truncated)"
    And a message longer than 120 characters is elided in the issue title
    And the generated URL stays under GitHub's ~8k GET limit

  @chaos
  Scenario: Nowhere to report to
    Given the extension declares no "bugs" url
    When the user clicks "Report Issue"
    Then no browser tab is opened, rather than a broken one
```
