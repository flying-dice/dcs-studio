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

    @chaos
    Scenario Outline: GitHub fails while the product page loads
      Given the page is loading "<owner/repo>"
      When <request> fails with <failure>
      Then the error card shows "<message>" with a "Try again" button
      And "Try again" re-runs the same product load from the start

      Examples:
        | request             | failure                             | message                                                                 |
        | the repo lookup     | 404 Not Found                       | Repository <owner/repo> was not found.                                  |
        | the README fetch    | 500 Internal Server Error           | GitHub 500: Internal Server Error                                       |
        | the latest release  | 403 "API rate limit exceeded"       | GitHub rate limit reached. Sign in to raise the limit, or wait a minute. |

    @chaos
    Scenario: A slow load that finishes after the user moved on
      Given the user pressed Back and opened a different mod
      When the first mod's load finally fails
      Then the failure is discarded — a product error is only rendered when it
        names the mod currently on screen
      And the second mod's page is left untouched

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

    @chaos
    Scenario: The manifest asset is listed but cannot be read
      Given the latest release ships a "dcs-studio.toml" the host cannot
        download or parse
      Then the page still renders — this is not treated as a load failure
      And an "Install actions unknown" warning replaces the whole install
        breakdown, saying the manifest could not be read and to proceed
        only if the source is trusted
      And the "Install" button is still offered, because installability is
        decided by the asset being listed on the release, not by it being readable

    @chaos
    Scenario: A release that ships a manifest but no payload
      Given the latest release ships a "dcs-studio.toml" and no .7z volume
      Then the card offers "Install" exactly as it would for a complete release
      And the missing payload is only reported after the click, as
        "This release has no .7z payload to install."

  Rule: The aside states the install facts

    Scenario: Install plan
      Given the release manifest declares [[symlink]] rules
      Then an "Install plan" card lists each rule as
        source → resolved absolute destination on this machine

    Scenario: Required DCS modules
      Given the manifest declares [[requires_module]] entries
      Then a "Requires DCS modules" card lists each module id

    Scenario: Download details
      Then a "Download" card shows the humanized total size
      And lists each release asset with its size
      Or shows "No release assets." when there are none

    @chaos
    Scenario: A destination that cannot be resolved on this machine
      Given the manifest installs under {GameInstall}
      And "dcsStudio.gameInstallPath" is not configured
      Then the plan row falls back to the declared token destination
        instead of an absolute path
      And the page does not warn that this install cannot succeed —
        the unresolvable destination is only reported when Install is clicked
        (see story 006)

    @chaos
    Scenario: A release with no assets at all
      Then the "Download" card shows "—" as the total size
      And shows "No release assets."

  Rule: A third party's release content is untrusted input

    @chaos
    Scenario: A README carrying markup, a script block or a javascript: link
      Given the repo README contains raw HTML and a "javascript:" link
      Then the README is escaped before any markdown formatting is applied,
        so the markup is shown as text
      And nothing in it executes: the document's CSP is "default-src 'none'"
        with scripts allowed only under the document's own nonce

    @chaos
    Scenario: A manifest declaring a before-sanitize mission script
      Given the manifest declares a [[mission_script]] with
        run_on = "before-sanitize"
      Then a "Script Execution Notice" alert leads the mission-script section,
        warning of full os/io/lfs/require access
      And a "pre-sanitize-script" risk badge is shown above the fold,
        before the "Install" action
      And the mission-script row itself is tagged "before-sanitize"
      And "Learn more about script sanitization" opens the sandbox docs page

    @chaos
    Scenario: A manifest whose destination walks out of the DCS roots
      Given a [[symlink]] rule with dest "{SavedGames}/../../Windows/System32"
      Then the install plan still enumerates every rule, so the user can see
        what the mod wanted to do
      And the offending rule is flagged, and only that one
      And the "Install" action is replaced by "Not installable — this mod's
        manifest asks to write outside your DCS folders", listing each path
        and what it reaches outside of
      And an install message arriving anyway — from a page rendered before the
        manifest was re-read — is refused before anything is downloaded

    @chaos
    Scenario: A mod already installed before its manifest started escaping
      Given the mod is installed
      And its latest release's manifest now names a path outside the DCS roots
      Then the page still offers "Uninstall" — refusing the install must not
        take away the way out of one done earlier
```

## Design intent (not yet implemented)

The preview fixtures (`src/marketplace/mockData.ts`) model one behaviour the live page does not yet render:

- **Owned/missing verdicts** on required DCS modules (green "owned" / red "missing" per module).

This should be treated as intended future scope for this story.
