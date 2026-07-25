# 006 — Install a Mod into DCS

## Story

> **As a** DCS player,
> **I want** one-click install that downloads the release payload, unpacks it to a managed data dir, and links the files into my DCS folders with visible progress,
> **so that** mods land in the right places without me touching the filesystem.

## Context

- Triggered by **Install** on a product page. The lifecycle is *subscribe* (download + unpack to `<dataDir>/<repo-key>`) then *enable* (create links into DCS per the manifest's `[[symlink]]` rules).
- Links use the dropzone strategy: directories become junctions, same-volume files hard links, cross-volume files symlinks (with a UAC elevation retry on permission errors).
- A destination directory that already exists as a real folder (e.g. `Saved Games\Scripts\Hooks`) is merged into: each child of the source is linked individually (recursively), so shared DCS folders never block an install and disabling removes only the mod's own links.
- Preconditions: 7-Zip available, a data dir (default `%USERPROFILE%\DCSStudio\mods`), and configured roots for every destination the manifest uses.

```gherkin
Feature: One-click mod install
  Install = download release volumes → extract with 7-Zip → link into DCS,
  with streamed progress on the product page.

  Background:
    Given the user is on the product page of an installable mod

  Rule: Progress is visible at every phase

    Scenario: Happy-path install
      When the user clicks "Install"
      Then the button is replaced by a progress block starting at "Starting…"
      And the user sees, in order:
        | Phase    | Label                                |
        | download | Downloading <asset> (<i>/<n>) with a percentage bar |
        | extract  | Extracting payload…                  |
        | link     | Linking into DCS…                    |
        | done     | Installed.                           |
      And the card flips to the "Installed" state with an "Uninstall" button
      And a toast confirms "Installed <name> into your DCS folders."

    Scenario: Multi-volume payloads
      Given the release payload is split into .7z.001, .7z.002, … volumes
      Then every volume is downloaded with its own "(i/n)" progress
      And extraction runs against the first volume

  Rule: A failure before extraction leaves the ledger untouched

    @chaos
    Scenario: The connection drops midway through a volume download
      When the payload stream fails partway through
      Then the install fails with the underlying stream error
      And no ledger entry is written — a subscription is only recorded
        after the payload has been extracted
      And the partial volumes are left in "<dataDir>\<repo-key>\.download"
      And a retry wipes ".download" before downloading again, so the retry
        never resumes from a truncated file

    @chaos
    Scenario Outline: The asset URL does not serve the payload
      When GitHub answers the asset download with <status>
      Then the install fails with "Download failed (<status>) for <url>"
      And nothing is extracted, linked or recorded

      Examples:
        | status |
        | 403    |
        | 404    |
        | 500    |

  Rule: Re-installing over a working mod is the dangerous case

    @chaos
    Scenario: Extraction fails after the previous payload was already cleared
      Given the mod is already installed and enabled
      When the user installs it again
      And extraction fails — a truncated volume, a full disk,
        or 7-Zip exiting non-zero
      Then the install fails with 7-Zip's exit code and its stderr
      And the previously unpacked files are already gone: prior content is
        cleared before extraction and nothing restores it
      And the ledger still records the mod as installed and enabled at the
        old tag, so its links now point at files that no longer exist
      And the ".download" folder is left behind, because cleanup only runs
        after a successful extraction
      # UNVERIFIED: whether this half-state is intended. Only the LINKING step
      # rolls back; the clear-then-extract step has no rollback and no guard.

    @chaos
    Scenario: Installing over a subscription that is already enabled
      Given the ledger already records the mod as installed and enabled
      And the product page's "Installed" state is stale, so "Install"
        is still offered
      When the user clicks "Install"
      Then the payload is re-downloaded and re-unpacked over the data dir
      And the re-subscribe preserves the recorded enabled flag and link list
      And the linking step is skipped entirely, because enable returns early
        for a mod already marked enabled — no link is re-created or re-pointed
      And the install still reports "Installed."
      # UNVERIFIED: whether the surviving links still resolve to the NEW files.
      # A Windows hard link created for the previous file is not re-pointed by
      # a fresh extraction.

  Rule: Preconditions fail with actionable messages

    Scenario: 7-Zip missing
      Given 7-Zip cannot be found on this machine
      When the user clicks "Install"
      Then the install fails with
        "7-Zip not found — install 7-Zip (7-zip.org) to install mods."

    Scenario: No payload
      Given the release ships no .7z payload
      Then the install fails with
        "This release has no .7z payload to install."

    Scenario: No release
      Given the mod has no release tag
      Then the page shows "This mod has no release to install."

    Scenario: Unresolvable destination
      Given the manifest installs under {GameInstall}
      And "dcsStudio.gameInstallPath" is not configured
      Then linking fails with
        "Cannot resolve <dest> — configure {GameInstall} in Settings."

    Scenario: Any install failure
      When any phase throws
      Then the error message shows inline on the product page
      And an "Install failed: …" error notification appears
        with a "Report Issue" button
      And partially created links from the failed enable are rolled back

    @chaos
    Scenario: 7-Zip disappears between the precondition check and the extraction
      Given 7-Zip was found when the install started
      And it is no longer resolvable by the time extraction runs
      Then the install fails with
        "7-Zip not found — install 7-Zip (7-zip.org) to install mods."
      because the archiver is resolved again at extraction time, not cached

    @chaos
    Scenario: The release ships split volumes but not the first one
      Given the release ships ".7z.002" and ".7z.003" but no ".7z.001"
      When the user clicks "Install"
      Then both listed volumes are still downloaded
      And extraction is pointed at ".7z.002" — the first name in sort order —
        and fails with 7-Zip's non-zero exit and its stderr
      And no ledger entry is written

  Rule: The manifest comes from a stranger's release and must not reach outside the DCS roots

    @chaos
    Scenario Outline: A destination that looks absolute is pinned under the root anyway
      Given a [[symlink]] rule whose dest is "<dest>"
      When the install resolves that rule
      Then it resolves under the configured root, to "<resolved>":
        an unrecognised root token is treated as {SavedGames} and any leading
        separator is stripped
      And nothing is written to the literal path the manifest asked for

      Examples:
        | dest                      | resolved                               |
        | C:/Windows/System32/evil  | {SavedGames}\C:\Windows\System32\evil  |
        | //server/share/payload    | {SavedGames}\server\share\payload      |
        | /Scripts/Hooks            | {SavedGames}\Scripts\Hooks             |

    @chaos
    Scenario: A destination that walks up out of the DCS roots
      Given a [[symlink]] rule with dest "{SavedGames}/../../Windows/System32/evil.dll"
      When the user clicks "Install"
      Then the rule is rejected before any link is created, naming it
      And nothing is written outside the configured {SavedGames} / {GameInstall}
        roots # UNVERIFIED: the dest is joined verbatim — ".." is neither stripped nor normalised and there is no containment check, so today this resolves outside the roots and is handed to the linker

    @chaos
    Scenario: A source that walks up out of the mod's unpacked folder
      Given a [[symlink]] rule with source "../../Windows/System32"
      When the user clicks "Install"
      Then the rule is rejected, naming it
      And no link created in the DCS folders points at anything outside the
        mod's own unpacked directory # UNVERIFIED: source is joined onto the unpacked dir with no containment check, so today the escaped path is linked whenever it exists

    @chaos
    Scenario: A destination naming an NTFS alternate data stream
      Given a [[symlink]] rule with dest "{SavedGames}/notes.txt:hidden"
      Then the rule is rejected the way the bridge's write-root guard rejects
        alternate-data-stream writes # UNVERIFIED: the install path has no such guard; the dest resolves to "<SavedGames>\notes.txt:hidden" and is passed to the linker as an ordinary path

  Rule: Shared DCS folders never block an install

    Scenario: Destination directory already exists
      Given the manifest installs a directory to Scripts\Hooks
      And Scripts\Hooks already exists in Saved Games
      When the user clicks "Install"
      Then each child of the source directory is linked into Scripts\Hooks individually
      And the pre-existing contents of Scripts\Hooks are untouched
      And uninstalling later removes only this mod's links

    Scenario: Real file conflict inside a merged directory
      Given Scripts\Hooks already contains a real file with the same name as a mod file
      When the user clicks "Install"
      Then linking fails with "Destination path already exists: <that file>"
      And partially created links are rolled back

  Rule: Elevation is requested only when required

    Scenario: Cross-volume file link without privileges
      Given a file must be symlinked across volumes
      And symlink creation is denied with a permission error
      Then a UAC elevation prompt is raised to create the link

    @chaos
    Scenario: The UAC prompt is declined
      Given a cross-volume file link was denied with a permission error
      When the user dismisses the elevation prompt
      Then the elevated helper exits non-zero and the install fails with its
        message, or with "exit <code>" when it produced no output
      And every link created so far is rolled back

  Rule: A partial link set is never left behind

    @chaos
    Scenario: The second of three link rules fails
      Given the manifest declares three [[symlink]] rules
      And the payload does not contain the source the second rule names
      When the user clicks "Install"
      Then linking fails with "Source path does not exist: <path>"
      And the links created for the first rule are removed again
      And the mod is left subscribed but DISABLED, with no links recorded —
        the download and unpack are not undone, only the linking

Feature: Uninstall from the product page

  Scenario: Uninstalling
    Given the mod is installed
    When the user clicks "Uninstall"
    Then all links into DCS are removed
    And the unpacked files and ledger entry are deleted
    And a toast confirms "Uninstalled <repo>."
    And the card returns to the "Install" state

  @chaos
  Scenario: The unpacked folder cannot be deleted
    Given DCS or another process holds a file open in the mod's unpacked folder
    When the user clicks "Uninstall"
    Then the links into DCS have already been removed
    And deleting the folder fails, so the ledger entry is NOT dropped
    And the failure is shown inline on the card, without an error notification
    And the mod is still recorded as installed while its links are gone
    # UNVERIFIED: whether leaving the ledger entry (rather than rolling the
    # links back) is intended — uninstall unlinks first and deletes second,
    # with no compensation if the delete throws.

  @chaos
  Scenario: Uninstalling a mod that is no longer in the ledger
    Given the subscription was removed in another window
    When the user clicks "Uninstall"
    Then nothing is touched on disk
    And the card still returns to the "Install" state and a toast confirms
      "Uninstalled <repo>." — the uninstall is idempotent
```
