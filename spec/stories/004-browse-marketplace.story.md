# 004 — Browse the Marketplace Storefront

## Story

> **As a** DCS player looking for community content,
> **I want** to browse, search, filter and sort mods discovered from GitHub,
> **so that** I can find a mod worth installing without knowing repo names in advance.

## Context

- Entry points: command **"DCS Studio: Open Marketplace"** (`dcs.marketplace.open`), the **Browse Mods** launcher row, and the **"$(package) DCS Marketplace"** status bar item. **"DCS Studio: Refresh Marketplace"** re-runs discovery when the panel is open.
- Discovery searches GitHub for public repositories tagged with the topic from `dcsStudio.discoveryTopic` (default `dcs-studio`).
- GitHub auth uses VS Code's built-in GitHub provider with empty scopes — it only raises the API rate limit; anonymous browsing is allowed.

```gherkin
Feature: Marketplace discovery and sign-in gate
  The storefront discovers mods from GitHub; the user may sign in
  (higher rate limit) or browse as a guest.

  Scenario: Opening the Marketplace while signed out
    Given the user has no GitHub session in VS Code
    When the Marketplace opens
    Then a sign-in wall is shown with the heading
      "Sign in to browse the Marketplace"
    And the body explains discovery searches GitHub for repos tagged
      with the discovery topic, and that signing in raises the rate limit
    And it offers "Sign in with GitHub" and "Browse without signing in"

  Scenario: Signing in with GitHub
    When the user clicks "Sign in with GitHub" and completes the consent flow
    Then the header shows their GitHub login
    And discovery runs automatically

  Scenario: Browsing as a guest
    When the user clicks "Browse without signing in"
    Then the header shows "browsing as guest"
    And discovery runs anonymously against the public API

  Scenario: Cancelling the GitHub consent dialog
    When the user dismisses the sign-in prompt
    Then they remain on the sign-in wall

  Scenario: Hitting the anonymous rate limit
    Given the user is browsing as a guest
    When GitHub returns a rate-limit response
    Then an error banner shows
      "GitHub rate limit reached. Sign in to raise the limit, or wait a minute."

Feature: Storefront grid
  A searchable, filterable, sortable grid of mod cards.

  Background:
    Given discovery has returned listings

  Scenario: Card anatomy
    Then each card shows the owner avatar, mod name, "by <author>",
      a star count, a description clamped to three lines,
      and up to six tag chips
    And the card footer offers "Details" and "GitHub ↗"

  Scenario: Searching
    When the user types into the "Search mods…" box
    Then the grid filters live across name, author, description and tags

  Scenario: Filtering by tag
    When the user clicks a tag chip on a card
      or picks a tag from the tag dropdown
    Then only mods carrying that tag remain
    And picking "All tags" clears the filter

  Scenario Outline: Sorting
    When the user selects "<option>" in the sort dropdown
    Then the grid orders by <order>

    Examples:
      | option     | order                  |
      | Most stars | star count, descending |
      | Name       | name, alphabetical     |

  Scenario: Refreshing
    When the user clicks the Refresh button
      or runs "DCS Studio: Refresh Marketplace"
    Then discovery re-runs against GitHub
    And the button shows a spinner while busy

  Scenario: No mods published yet
    Given the discovery topic matches no public repos
    Then the grid area explains no repos are tagged with the topic yet
      and how to publish one by adding the topic to a GitHub repo

  Scenario: No search matches
    Given listings exist but none match the current query
    Then the grid shows "No mods match your search."

  Scenario: Opening a mod
    When the user clicks a card or its "Details" button
    Then the product page for that mod opens (see story 005)

  Scenario: Jumping to the repo
    When the user clicks "GitHub ↗" on a card
    Then the repository opens in the system browser
```
