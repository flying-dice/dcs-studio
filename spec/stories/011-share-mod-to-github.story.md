# 011 — Publish: Preflight & Share to GitHub

## Story

> **As a** mod author with a working project,
> **I want** guided preflight checks and a one-click "share" that creates the public repo, pushes my code and tags it for Marketplace discovery,
> **so that** my mod becomes discoverable without me knowing the git/GitHub incantations.

## Context

- Entry points: command **"DCS Studio: Publish Mod to GitHub…"** (`dcs.publish.open`), the cloud-upload icon in the editor title of `dcs-studio.toml`, and the **Publish Mod** launcher row (visible only when a manifest exists).
- The publish flow shells out to `git` and the `gh` CLI — GitHub auth is `gh auth login`, independent of the editor's GitHub session.
- Sharing tags the repo with the `dcs-studio` topic (plus `dcs-studio-library` for libraries), which is exactly what Marketplace discovery searches for (story 004).

```gherkin
Feature: Publish preflight
  Red checks block both publish actions until resolved.

  Scenario: No folder open
    Given no workspace folder is open
    Then the panel shows "Open a project folder" and nothing else

  Scenario: The preflight check list
    When the Publish panel opens
    Then it runs and displays these checks with ok/warn/error dots:
      | Check           | Error condition and message                                          |
      | Manifest        | "dcs-studio.toml not found in the workspace root." / "Could not parse dcs-studio.toml." |
      | Project name    | "[project] name is required."                                        |
      | Install rules   | warn: "No [[install]] rules — the release will ship only the manifest." |
      | Install sources | "N of M source(s) missing — build the project first." or "N source(s) are symlinks (refused by the packager)." |
      | 7-Zip           | "7z not found. Install 7-Zip (7-zip.org) and retry."                 |
      | git             | "git not found on PATH."                                             |
      | GitHub CLI      | "gh not found. Install from cli.github.com." / "gh is not signed in. Run: gh auth login" |

  Scenario: Blocked by red checks
    Given any check is error-level
    Then both action buttons are disabled
    And a banner reads "Resolve the red items above to publish."

  Scenario: Re-checking
    When the user clicks "Re-check"
    Then all preflight checks re-run

Feature: Step 1 — Share to GitHub

  Background:
    Given all preflight checks pass

  Scenario: Sharing a new project
    Given the project has no GitHub remote yet
    When the user fills in Repository name and Description
      and clicks "Share to GitHub"
    Then the button shows "Sharing…" and a log panel streams progress
    And the flow, in order:
      initialises git on branch main if needed,
      adds ".dcs-studio/" to .gitignore,
      commits pending changes as "Publish with DCS Studio",
      creates the public repo and pushes,
      and tags the repo with the "dcs-studio" topic
    And the result reads "Shared → <owner>/<name>. Cut a release below."
    And the release step's Repo field is prefilled

  Scenario: Publishing a library
    Given the user ticks
      "Publish as a library (dependency-only — adds the dcs-studio-library topic)"
    Then the repo is additionally tagged "dcs-studio-library"

  Scenario: Repo already exists on GitHub
    Given a repo with that name already exists
    Then the log notes "Repo already exists — pushing to it."
    And the project is pushed to it instead

  Scenario: Already shared
    Given the project already has a GitHub origin remote
    Then the panel shows
      "Already on GitHub: <owner>/<name>. You can re-push by sharing again."

  Scenario: Not signed in to gh
    Given "gh" has no authenticated session
    Then the share fails with
      "Not signed in to gh — run `gh auth login`."

  Scenario: Failures land in the log
    When any step fails
    Then the log shows "✖ <message>" and the button re-enables
    And no blocking modal appears
```
