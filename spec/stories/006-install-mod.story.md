# 006 — Install a Mod into DCS

## Story

> **As a** DCS player,
> **I want** one-click install that downloads the release payload, unpacks it to a managed data dir, and links the files into my DCS folders with visible progress,
> **so that** mods land in the right places without me touching the filesystem.

## Context

- Triggered by **Install** on a product page. The lifecycle is *subscribe* (download + unpack to `<dataDir>/<repo-key>`) then *enable* (create links into DCS per the manifest's `[[install]]` rules).
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

Feature: Uninstall from the product page

  Scenario: Uninstalling
    Given the mod is installed
    When the user clicks "Uninstall"
    Then all links into DCS are removed
    And the unpacked files and ledger entry are deleted
    And a toast confirms "Uninstalled <repo>."
    And the card returns to the "Install" state
```
