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

  Rule: The Agent Skills row advertises pending updates

    Scenario: A newer bundled skill exists
      Given an installed agent skill is older than the bundled version
      Then the "Agent Skills" row shows a count badge
      And its description reads "Skill update available"

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

  Scenario: Offline click routes to the launch entrypoint (story 015)
    Given the GUI bridge is not connected
    When the user clicks the bridge status bar item and picks "Launch DCS (with bridge)"
    Then "dcs.bridge.launch" runs (see story 015 for its full behavior)

Feature: Error reporting escape hatch
  Every error notification raised through the extension's error helper
  carries a "Report Issue" action.

  Scenario: Reporting a failure
    Given an operation fails and an error notification is shown
    When the user clicks "Report Issue"
    Then the browser opens a pre-filled GitHub issue
      including the message, a truncated stack trace,
      and extension / VS Code / OS version info
```
