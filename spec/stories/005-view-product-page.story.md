# 005 — Evaluate a Mod on its Product Page

## Story

> **As a** DCS player who found an interesting mod,
> **I want** a product page showing the README, install plan, required DCS modules, download size and release assets,
> **so that** I can judge exactly what will land on my machine before installing.

## Context

- Reached by clicking a card (or "Details") in the storefront grid; a Back button returns to the grid.
- The install plan is read from the standalone `dcs-studio.toml` asset attached to the mod's latest GitHub release — destinations are resolved against the user's configured `{SavedGames}` / `{GameInstall}` roots so the page shows real local paths.

```gherkin
Feature: Product page
  A two-column page: README and metadata on the left, an action card
  and install facts on the right.

  Background:
    Given the user opened a mod from the storefront

  Rule: The page shows what the mod is

    Scenario: Loading
      Then a "Loading <owner/repo>…" spinner shows while GitHub is queried
      And on failure an error card shows the message with a "Try again" button

    Scenario: Rendered content
      Then the page shows the avatar, name, "by <author>", star count,
        and the latest release tag when one exists
      And the repository README rendered as formatted text
      And "This repo has no README." when none exists
      And a "View on GitHub ↗" footer button

  Rule: The action card reflects the mod's install state

    Scenario: Installable mod, not yet installed
      Given the latest release ships a "dcs-studio.toml" and a payload
      Then the action card shows an "Install" button with the note
        "Downloads & unpacks to your data dir, then links the files into your DCS folders."

    Scenario: Already installed
      Given the mod is already subscribed on this machine
      Then the card shows "Installed", an "Uninstall" button,
        and the note "Enable/disable/update it under My Mods."

    Scenario: Not installable
      Given the latest release ships no "dcs-studio.toml"
      Then the card warns
        "Not installable — the latest release ships no dcs-studio.toml"
      And when the repo has no release at all, "(no release yet)" is appended

  Rule: The aside states the install facts

    Scenario: Install plan
      Given the release manifest declares [[install]] rules
      Then an "Install plan" card lists each rule as
        source → resolved absolute destination on this machine

    Scenario: Required DCS modules
      Given the manifest declares [[requires_module]] entries
      Then a "Requires DCS modules" card lists each module id

    Scenario: Download details
      Then a "Download" card shows the humanized total size
      And lists each release asset with its size
      Or shows "No release assets." when there are none
```

## Design intent (not yet implemented)

The preview fixtures (`src/marketplace/mockData.ts`) model one behaviour the live page does not yet render:

- **Owned/missing verdicts** on required DCS modules (green "owned" / red "missing" per module).

This should be treated as intended future scope for this story.
