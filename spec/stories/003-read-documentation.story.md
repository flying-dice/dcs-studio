# 003 — Read the Built-in Documentation

## Story

> **As a** new or returning DCS Studio user,
> **I want** guides for every feature inside the editor, cross-linked and able to launch the feature they describe,
> **so that** I can learn the tool without leaving VS Code or hunting for a wiki.

## Context

- Entry points: command **"DCS Studio: Open Documentation"** (`dcs.docs.open`, accepts an optional page id for deep links) and the **Documentation** row ("Guides for every feature") in the launcher sidebar.
- Content is bundled with the extension; no network needed.

```gherkin
Feature: Documentation panel
  A singleton "Documentation" webview with a table-of-contents sidebar
  and a page body, covering every DCS Studio feature.

  Background:
    Given the user opens the Documentation panel

  Rule: All features are documented and organised by section

    Scenario: Table of contents
      Then the sidebar lists sections and pages:
        | Section         | Pages                                                                   |
        | Getting Started | Welcome to DCS Studio                                                   |
        | Mod Manager     | Finding Mods, Installing Mods, What Is a Mod Bundle?, Updating & Uninstalling |
        | Creating Mods   | Creating a Project, dcs-studio.toml Reference, Publishing Your Mod      |
        | Tools           | DCS Console, DCS Unit Database, MissionScripting Sanitization, Scripting Sandbox & Trust, Lua Debugger, The Bridge (Inject / Launch), Settings & Paths |

    Scenario: First open lands on the overview
      Given the user has never viewed a docs page
      Then the "Welcome to DCS Studio" page is shown

    Scenario: The panel remembers the last page
      Given the user previously viewed the "Lua Debugger" page
      When the panel is reopened
      Then the "Lua Debugger" page is shown again

  Rule: Navigation works from many directions

    Scenario: Clicking a TOC entry
      When the user clicks a page link in the sidebar
      Then that page renders and the link is marked active

    Scenario: In-body cross-links
      Given a page contains a link to another docs page
      When the user clicks it
      Then the target page renders in place

    Scenario: Prev/Next pager
      Then every page ends with previous/next links
        that walk the flattened page order

    Scenario: Deep-linking from another feature
      When another feature opens the docs with a page id
      And the panel is already open
      Then the existing panel is revealed and navigates to that page

    @chaos
    Scenario Outline: A page id that does not exist
      Given the bundled content has no page with the id "<id>"
      When the panel is asked for it <via>
      Then <outcome>

      Examples:
        | id           | via                                        | outcome                                                                        |
        | renamed-away | as a deep link on first open               | the "Welcome to DCS Studio" page renders instead                               |
        | deleted-page | as the page remembered from the last visit | the "Welcome to DCS Studio" page renders instead                               |
        | no-such-page | as a navigation message to an open panel   | nothing renders; the reader stays on their current page and the stored page is not overwritten |
      # Only the boot paths fall back to Welcome; an unknown id sent to a live
      # panel is deliberately ignored so the reader's place is never lost.

    @chaos
    Scenario: The bundled content fails to load
      Given "docs-content.js" did not load
      When the Documentation panel opens
      Then the table-of-contents sidebar renders, empty
      And no page title or body is shown
      And the webview raises no error, rather than taking the panel down with it

  Rule: Docs can launch the features they describe

    Scenario Outline: Command buttons inside pages
      Given the user is reading a page with a "<button>" button
      When they click it
      Then the "<command>" command executes

      Examples:
        | button                   | command             |
        | Open Settings            | dcs.setup.open      |
        | Open Marketplace         | dcs.marketplace.open |
        | Open MissionScripting.lua | dcs.mission.open    |
        | Open Lua Console         | dcs.bridge.console  |
        | Inject Bridge            | dcs.bridge.inject   |
        | Open Publish Panel       | dcs.publish.open    |

    Scenario: External links open in the browser
      When the user clicks an http(s) link in a page
      Then it opens in the system browser, not the webview

    @chaos
    Scenario: A command button whose command this build no longer registers
      Given the user is reading the "Publishing Your Mod" page
      When they click "Open Publish Panel" and that command is not registered
      Then the panel stays on "Publishing Your Mod" rather than navigating
      And the click is silently ignored  # UNVERIFIED: the host fires the command without awaiting it, so a missing command produces no user-visible feedback
```
