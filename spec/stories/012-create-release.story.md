# 012 — Publish: Package & Create a Release

## Story

> **As a** mod author with a shared repo,
> **I want** the extension to package my manifest and install sources into a 7z payload (split when large) and publish it as a GitHub release with the manifest alongside,
> **so that** the Marketplace can read my install plan and consumers can one-click install exactly what I built.

## Context

- Step 2 of the Publish panel (story 011 covers preflight and sharing). Requires the repo to exist — prefilled after Share, or entered manually as `owner/name`.
- The standalone `dcs-studio.toml` uploaded next to the payload is what makes the release *installable* to the Marketplace (stories 005/006).

```gherkin
Feature: Create a release

  Background:
    Given the Publish panel is open with all preflight checks passing
    And the project has been shared to GitHub

  Scenario: Release form
    Then the "2 · Create a release" card offers:
      a Repo field (owner/name, prefilled after sharing),
      a Tag field (prefilled "v<manifest version>"),
      and a Release notes textarea

  Scenario: Happy-path release
    When the user clicks "Package & publish release"
    Then the button shows "Publishing…" and the log streams:
      "Packaging payload with 7-Zip…",
      either "Packaged a single archive (<size>)." or "Split into N volumes (<size> total).",
      "Creating release <tag> and uploading N assets…"
    And the uploaded assets are the 7z payload (or its volumes)
      plus the standalone dcs-studio.toml
    And the result reads "Published release <tag> · view on GitHub"
      with the asset filenames listed
    And "view on GitHub" opens the release page in the browser

  Scenario: Large payloads are split into GitHub-safe volumes
    Given the packaged archive exceeds the volume limit
    Then it is repacked into numbered volumes (.7z.001, .7z.002, …)
      each under GitHub's asset size cap

  Scenario: Re-publishing the same tag is idempotent
    Given a release with the same tag already exists
    When the user publishes again
    Then the prior release and tag are deleted first
    And the new release replaces them

  Scenario: Malformed repo field
    Given the Repo field is not "owner/name" shaped
    When the user clicks "Package & publish release"
    Then the log shows
      "✖ Enter the repo as owner/name (share first if you haven't)."
    And nothing is packaged

  Scenario Outline: Packaging failures
    Given <condition>
    Then the release fails with "<message>"

    Examples:
      | condition                          | message                                                  |
      | the manifest cannot be read        | Cannot read dcs-studio.toml.                             |
      | 7-Zip is missing                   | 7z not found.                                            |
      | a [[bundle]] path is missing        | Bundle path missing: <path> — build the project first.   |

  Scenario: Default release notes
    Given the notes textarea is left empty
    Then the release is created with the notes "Release <tag>"
```
