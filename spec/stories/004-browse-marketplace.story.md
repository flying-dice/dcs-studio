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

  Rule: A GitHub failure degrades the storefront, it never breaks it

    @chaos
    Scenario Outline: Discovery fails against GitHub
      Given the user is browsing as a guest
      And listings from an earlier pass are already on screen
      When the repository search answers with <response>
      Then an error banner shows "<message>"
      And the cards already on screen stay — search, tag filter and sort still work
      And Refresh is offered again rather than the panel going blank

      Examples:
        | response                                   | message                                                                 |
        | 403 whose body says "API rate limit exceeded" | GitHub rate limit reached. Sign in to raise the limit, or wait a minute. |
        | 403 whose body says organization SAML      | GitHub 403: Resource protected by organization SAML                     |
        | 500 with a JSON body                       | GitHub 500: Internal Server Error                                       |
        | 500 with an HTML body that is not JSON     | GitHub 500: Internal Server Error                                       |
        | 422 whose body says "Validation Failed"    | GitHub 422: Validation Failed                                           |

    @chaos
    Scenario: The very first discovery fails, before anything has loaded
      Given no listings have ever loaded in this panel
      When discovery fails against GitHub
      Then the error banner is shown above the grid area
      And the grid area still shows the "no repos are tagged … yet" empty state,
        because the webview has no listings to draw
      And the two are shown together — the empty state is not suppressed
        by the error

    @chaos
    Scenario: GitHub answers the repository search with a 404
      Given the user is browsing as a guest
      When the repository search returns 404
      Then no error banner is shown — a 404 is read as "nothing found", not a failure
      And the grid explains no repos are tagged with the topic yet

    @chaos
    Scenario: The GitHub session is revoked while the storefront is open
      Given the user signed in and listings are on screen
      When the GitHub session is signed out elsewhere in VS Code
      Then auth state is re-read and the sign-in wall replaces the grid
      And "Browse without signing in" gets the user back to the storefront

    @chaos
    Scenario: More tagged repos than one page of results
      Given more than 100 public repos carry the discovery topic
      Then discovery asks GitHub for a single page of 100, sorted by stars descending
      And only those 100 can ever appear — the storefront does not paginate

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

  Rule: A card is built from a stranger's repo metadata, so it renders as text

    @chaos
    Scenario: A search hit with fields missing or null
      Given a repo has no owner block, a null description, no topics
        and no star count
      Then the card still renders, with an empty author, no blurb,
        no tag chips and 0 stars
      And when the avatar image fails to load it falls back to generated initials

    @chaos
    Scenario: A repo name or description containing markup
      Given a repo description of "<img src=x onerror=alert(1)>"
      Then it is escaped and shown as literal text in the card blurb
      And nothing in it executes: the document's CSP is "default-src 'none'"
        and scripts are allowed only under the document's own nonce

  Rule: The storefront controls stay honest under stress

    @chaos
    Scenario: Refreshing while a discovery pass is still running
      When the user clicks Refresh
      Then the button is disabled and shows a spinner for the duration,
        so a second pass cannot be queued by a double-click

    @chaos
    Scenario: A tag filter that the next refresh cannot satisfy
      Given the user filtered by a tag chip
      When a refresh returns listings that no longer carry that tag
      Then the filter is kept and the grid shows "No mods match your search."
      And picking "All tags" brings the listings back

    @chaos
    Scenario: Refreshing the Marketplace when it was never opened
      Given the Marketplace panel is not open
      When the user runs "DCS Studio: Refresh Marketplace"
      Then nothing happens — no panel is opened and no request is made

    @chaos
    Scenario: Opening the Marketplace a second time
      Given the Marketplace panel is already open
      When the user runs "DCS Studio: Open Marketplace"
      Then the existing panel is revealed rather than a second one created
      And discovery is not re-run

    @chaos
    Scenario Outline: A discovery topic that carries no usable value
      Given "dcsStudio.discoveryTopic" is <setting>
      When discovery runs
      Then it searches for the topic "dcs-studio"

      Examples:
        | setting          |
        | unset            |
        | an empty string  |
        | only whitespace  |
```
