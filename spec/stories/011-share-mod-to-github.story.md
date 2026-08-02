# 011 — Publish: Preflight & Share to GitHub

## Story

> **As a** mod author with a working project,
> **I want** guided preflight checks and a one-click "share" that creates the public repo, pushes my code and tags it for Marketplace discovery,
> **so that** my mod becomes discoverable without me knowing the git/GitHub incantations.

## Context

- Entry points: command **"DCS Studio: Publish Mod to GitHub…"** (`dcs.publish.open`), the cloud-upload icon in the editor title of `dcs-studio.toml`, and the **Publish Mod** launcher row (visible only when a manifest exists).
- The publish flow shells out to `git` and the `gh` CLI — GitHub auth is `gh auth login`, independent of the editor's GitHub session.
- Sharing tags the repo with the `dcs-studio` topic, which is exactly what Marketplace discovery searches for (story 004).

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
      | Manifest        | "dcs-studio.toml not found in the workspace root." / "dcs-studio.toml could not be read." / rejects a manifest still using the legacy single-array install format — replace each rule with [[bundle]] + [[symlink]]. |
      | Project name    | "[project] name is required."                                        |
      | Bundle paths    | warn: "No [[bundle]] paths — the release will ship only the manifest." |
      | Bundle paths    | "N of M bundle path(s) missing — build the project first." or "N bundle path(s) are symlinks (refused by the packager)." |
      | Symlink coverage | "N symlink source(s) not inside any [[bundle]] path."                |
      | Executables     | "N entrypoint exe(s) not inside any [[bundle]] path." / "N duplicate entrypoint id(s) …" |
      | Mission scripts | script not inside any [[bundle]] path / invalid run_on / empty name  |
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

  @chaos
  Scenario: A manifest that is garbage blocks on the name, not on a parse error
    Given "dcs-studio.toml" contains no recognisable TOML at all
    Then the Manifest check is still green, because the parser is tolerant
      by design and yields an empty model rather than throwing
    And what blocks publishing is "[project] name is required." instead
    And the check no longer claims a parse failure it cannot detect: the
      message for a manifest that exists but yields no model reads
      "dcs-studio.toml could not be read.", which is the only way to reach
      it — deleted between the existence check and the read, or unreadable
      by this process

  @chaos
  Scenario: A [project] name written as a TOML number
    Given the manifest carries name = 2024 — a valid TOML integer,
      not a quoted string
    Then the parser normalises the value to its literal source text "2024"
    And the Project name check is simply green, exactly as the form shows it

  @chaos
  Scenario: A bundle path that exists but is a symlink
    Given a [[bundle]] path resolves to a symbolic link
    Then the Bundle paths check is error-level with
      "N bundle path(s) are symlinks (refused by the packager)."
    And each offending path is listed under the detail line as
      "symlink: <path>"
    And the missing-path failure takes priority — a run with both
      missing and symlinked paths reports the missing ones first

  @chaos
  Scenario: The rendered checks are a snapshot, but the action is gated
    Given every check passed when the panel last ran them
    When the manifest is deleted, or a [[bundle]] path is removed,
      without the user clicking "Re-check"
    Then both buttons still look enabled — the disabled state comes from the
      last results, which nothing invalidates
    But pressing either one re-runs preflight in the host first, and the
      action is refused before it touches git, gh or the archiver
    And the log names the blocking check, e.g.
      "✖ Manifest: dcs-studio.toml not found in the workspace root."
    And the re-run results are pushed back to the panel, so the red items
      appear without the user asking for them
    And the busy latch clears, so the button is usable again

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
    And the result reads "Shared → <owner>/<name>. Create a release below."
    And the release step's Repo field is prefilled — but only when it is
      empty; a repo the user typed is never overwritten

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

  @chaos
  Scenario: Not signed in — nothing local is touched
    Given "gh" has no authenticated session
    When the user clicks "Share to GitHub"
    Then the flow fails with "Not signed in to gh — run `gh auth login`."
      before any git command runs
    And no repo is initialised, no .gitignore is written, nothing is committed

  @chaos
  Scenario: The repo is created but the push is rejected
    Given the GitHub repo is created and the push then fails —
      a rejected push, a dropped network, a mid-upload disconnect
    Then the log shows "✖ gh repo create: <stderr>" and the button re-enables
    But the user is left half-published: the local folder is now a git repo
      on branch main with a "Publish with DCS Studio" commit,
      an empty public repository exists on GitHub,
      and the discovery topic was never applied
      # UNVERIFIED: that `gh repo create --source --push` leaves the repository behind when only its push fails was not exercised; the local git state and the missing topic follow directly from the ordering in publishService.share()
    And the documented recovery is to click "Share to GitHub" again —
      the second attempt takes the already-exists path, wires the origin
      remote and pushes "HEAD:main"
    And nothing is rolled back automatically

  @chaos
  Scenario: Tagging the discovery topic fails
    Given the repo was created and pushed
    When adding the "dcs-studio" topic fails — no permission, rate limited,
      or the network drops
    Then the failure still does not block the publish: topics are a nicety,
      and the repo and its push are already done
    But the log is written after the attempt and reports what happened —
      "⚠ Could not tag topic dcs-studio — the mod stays invisible to
      Marketplace discovery until it is tagged."
    And a successful tagging reads "Tagged topic: dcs-studio" instead, so
      the two outcomes are never confusable
    And re-running "Share to GitHub" retries the tagging

  @chaos
  Scenario: The commit step fails
    Given "git commit" fails — an empty tree, a hook rejecting the commit,
      a locked index
    Then the failure is swallowed by design and the flow continues
    And any real problem surfaces at the push instead

  @chaos
  Scenario: Sharing twice does not churn .gitignore
    Given ".gitignore" already contains a ".dcs-studio/" line
    When the user shares again
    Then the file is not rewritten
    And a ".gitignore" with no trailing newline gains one before the entry,
      rather than gluing the entry onto the last line

  @chaos
  Scenario: A repository name that GitHub will not accept verbatim
    Given the Repository name is prefilled from the manifest's [project] name,
      which for a scaffolded project is a human-readable name like "My Mod"
    When the user shares without editing it
    Then the reported owner/name comes from the "origin" remote that
      "gh repo create --source --remote" wired up, which is the repository
      GitHub actually created — not the name that was typed
    And the log says "GitHub named it <owner>/<name>." whenever the two differ
    And the repo URL, the discovery topic and the release step's prefill all
      address that same repository
    And a remote that is missing or is not a GitHub URL falls back to the
      requested name, which is the only answer left

  @chaos
  Scenario: Sharing while the panel has no workspace folder
    Given no workspace folder is open
    When a share or release message reaches the host anyway
    Then it is ignored — no busy state is posted and nothing runs
    And a late "busy" push arriving at the folderless panel is a no-op,
      not a crash

  @chaos
  Scenario: A failure the flow cannot describe
    Given a step throws a value that is not an Error
    Then the log still shows "✖ <the value as text>"
    And the busy latch is always cleared, so the button is never left dead
```
