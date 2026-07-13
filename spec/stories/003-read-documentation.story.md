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
        | Tools           | DCS Console, MissionScripting Sanitization, Lua Debugger, The Bridge — Inject/Launch, Settings & Paths |

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
```
