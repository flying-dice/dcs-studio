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
    Then the existing release is replaced in place: the new assets are
      uploaded over it, its title and notes are updated,
      and volumes the previous payload left behind are removed afterwards
    And neither the release nor the tag is ever deleted, so there is no
      moment where the version has no release
    And the log reads
      "Release <tag> already exists — uploading N assets over it…"
      then "Replaced release <tag> in place — the tag was never removed."

  Scenario: Malformed repo field
    Given the Repo field is not exactly "owner/name"
    When the user clicks "Package & publish release"
    Then the log shows
      "✖ Enter the repo as owner/name (share first if you haven't)."
    And nothing is packaged

  Scenario: Missing tag
    Given the Tag field is empty or whitespace
    When the user clicks "Package & publish release"
    Then the log shows "✖ Enter a tag for the release, e.g. v1.0.0."
    And nothing is packaged

  Scenario Outline: Packaging failures
    Given <condition>
    Then the release fails with "<message>"

    Examples:
      | condition                          | message                                                  |
      | the manifest cannot be read        | Cannot read dcs-studio.toml.                             |
      | 7-Zip is missing                   | 7z not found.                                            |
      | a [[bundle]] path is missing        | Bundle path missing: <path> — build the project first.   |
      | the tag is empty                   | A release tag is required (e.g. v1.0.0).                 |

  Scenario: Default release notes
    Given the notes textarea is left empty
    Then the release is created with the notes "Release <tag>"

  @chaos
  Scenario: The replacement upload fails part-way through
    Given a release with the same tag already exists on GitHub
    When the user clicks "Package & publish release"
    And the upload fails — it times out, the network drops part-way through
      a multi-volume payload, or the token lost its scope
    Then the previous release and its tag are still there, untouched,
      because nothing was deleted to make room for the replacement
    And anyone who already fetched that tag still has a tag the repo has
    And the log shows "✖ gh release upload: <stderr>"
    And the recovery is to fix the cause and publish again — the retry
      clobbers whatever assets did make it up

  @chaos
  Scenario: A first release for a tag dies mid-upload
    Given no release exists for this tag yet
    When the create fails after gh has already cut the release and its tag
    Then the half-created release AND its tag are deleted, because nothing
      existed for this tag before this attempt — the rollback restores the
      repository rather than destroying anything
    And the log says
      "Release <tag> failed — removing the half-created release and tag."
      before the "✖ <message>" line
    And a tag that never got created is a silent no-op to delete

  @chaos
  Scenario: Pruning a stale volume fails
    Given the previous payload needed more volumes than this one
    When a leftover volume cannot be detached
    Then the release still succeeds — its own assets are already uploaded
    And the log names the file it could not remove:
      "⚠ Could not remove stale asset <name> — delete it by hand before
      anyone installs."
    And assets outside this payload's volume family — screenshots, a
      changelog, anything attached by hand — are never proposed for deletion

  @chaos
  Scenario Outline: Repo fields the panel refuses to send
    Given the Repo field is "<repo>"
    When the user clicks "Package & publish release"
    Then the log shows
      "✖ Enter the repo as owner/name (share first if you haven't)."
    And no message reaches the host, so nothing is packaged, deleted
      or uploaded

    Examples:
      | repo             |
      | just-a-name      |
      | owner/           |
      | /name            |
      |                  |
      | owner/name/extra |

  @chaos
  Scenario: A repo field with too many segments is refused, not truncated
    Given the Repo field is "owner/name/extra"
    When the user clicks "Package & publish release"
    Then the guard rejects it rather than reading the first two segments
      and dropping the rest without comment
    And nothing is packaged or uploaded

  @chaos
  Scenario: An empty tag is guarded on both sides
    Given the user clears the Tag field
    When the user clicks "Package & publish release"
    Then the panel refuses it with
      "✖ Enter a tag for the release, e.g. v1.0.0."
      and no message reaches the host
    And a release message that reaches the host with an empty tag anyway
      fails with "A release tag is required (e.g. v1.0.0)." before the
      payload is packaged, rather than packaging under a base name ending
      in a bare hyphen and failing at the CLI
    And a tag with surrounding whitespace is trimmed once, so the packaged
      base name, the release and the result link all agree

  @chaos
  Scenario: A tag containing a slash is displayed truncated
    Given the Tag field is "release/1.0"
    When the release succeeds
    Then the result line shows only the last path segment as the tag,
      because it is read off the end of the release URL
    And the assets and the "view on GitHub" link are still correct

  @chaos
  Scenario: A bundle path missing stops the release before anything is packaged
    Given a [[bundle]] path does not exist on disk
    When the user clicks "Package & publish release"
    Then the log shows
      "✖ Bundle path missing: <path> — build the project first."
    And nothing is packaged, no release is deleted, and nothing is uploaded
    And the first missing path is the one named — the check stops there

  @chaos
  Scenario: A bundle path that is a symlink is not caught here
    Given a [[bundle]] path resolves to a symbolic link
    Then the release step only checks that the path exists, so it proceeds
    And preflight is the only thing that refuses symlinked bundle paths,
      which means a stale preflight lets one through to 7-Zip
      # UNVERIFIED: what 7-Zip then does with a symlinked path was not exercised; only the absence of a symlink check in cutRelease is verified

  @chaos
  Scenario: An empty bundle list still produces a release
    Given the manifest declares no [[bundle]] paths
    Then preflight warns
      "No [[bundle]] paths — the release will ship only the manifest."
      but does not block
    And the payload archive is packed from the manifest alone
    And the release ships two assets: the payload and the standalone
      dcs-studio.toml

  @chaos
  Scenario: The same bundle path declared twice
    Given two [[bundle]] blocks name the same path
    Then it is added to the archive once
    And the duplicate is not reported as an error

  @chaos
  Scenario: A requested volume size larger than GitHub allows
    Given a split size above GitHub's asset cap is requested
    Then the effective per-volume limit is clamped to 2 GiB minus 128 MiB
    Because an asset above that cap is rejected on upload, and a release
      that half-uploads is worse than one that never started

  @chaos
  Scenario: Re-publishing a payload that shrank
    Given a previous attempt left .7z volumes for this tag in
      ".dcs-studio/release"
    When the payload is packaged again and now needs fewer volumes
    Then the whole prior volume family for that base name is deleted first
    And only the volumes from this run are uploaded — a stale .7z.003
      from the previous attempt cannot ride along and corrupt the set
    And the same holds for the release itself: a .7z.003 already attached
      to the existing release is detached after the new volumes are up,
      because upload only overwrites the names it uploads

  @chaos
  Scenario: Package & publish cannot be fired twice
    When the user clicks "Package & publish release" and clicks again
      while it reads "Publishing…"
    Then the button is latched for the duration
    And a share running at the same time does not latch it, and vice versa —
      the busy state is scoped to the button that was pressed

  @chaos
  Scenario: A release failure leaves the panel usable
    When any step of the release fails
    Then the log shows "✖ <message>", the button re-arms and no modal appears
    And the packaged volumes stay in ".dcs-studio/release", which is
      gitignored, so a retry repacks over them rather than committing them
```
