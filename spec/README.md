# DCS Studio — Application Specification

DCS Studio is a VS Code extension that turns the editor into a complete
toolchain for DCS World modding: a **Marketplace** for discovering and
installing community mods, a **mod manager** built on a safe link-based
install model, an **authoring & publishing** pipeline from template to
GitHub release, and a **live sim link** (the bridge) providing a Lua
console, state explorer and a full in-sim Lua debugger.

Everything hangs off four user-configured paths (`{SavedGames}`, the game
install, a managed data dir, and 7-Zip) and one distribution convention:
a public GitHub repo tagged `dcs-studio` whose releases ship a
`dcs-studio.toml` manifest beside a 7z payload.

## Personas

| Persona | Who they are | Primary journeys |
| --- | --- | --- |
| **Mod consumer** | A DCS player who wants community content, not a dev environment | Browse → evaluate → install → manage; the desktop shortcut makes this app-like |
| **Mod author** | A scripter or native-mod developer distributing their work | Scaffold → author manifest → preflight → share → release |
| **Script developer** | Someone writing mission/hook Lua against the live sim | Sanitize → launch with bridge → console/explore → run/debug |
| **Contributor** | Someone changing DCS Studio's own bridge | Build from source → inject → verify |

## Application-level behaviour

```gherkin
Feature: DCS Studio extension
  A single activity-bar home unifying mod consumption, mod authoring
  and live-sim development inside VS Code.

  Scenario: The extension is always oriented around the user's sim
    Given the user has configured their DCS paths once
    Then installs, injection, launch, sanitization and the console
      all resolve against those same roots

  Scenario: The UI adapts to what the user is doing
    Given no project is open
    Then the consumer surfaces (Marketplace, My Mods) work standalone
    And given a workspace with a dcs-studio.toml
    Then the authoring and publishing surfaces light up

  Scenario: The live sim state is visible everywhere
    Then the status bar, launcher footer and console all reflect
      offline / at menu / mission running in real time

  Scenario: Nothing is irreversible
    Then installs are link-based and fully removable,
      MissionScripting edits are backed up and restorable,
      a clean-uninstall script survives the extension itself,
      and a paused sim always auto-recovers from a lost editor
```

## Feature map & story index

### Epic 1 — Getting started
| Story | Title |
| --- | --- |
| [001](stories/001-first-time-setup.story.md) | First-Time Setup: Point DCS Studio at the Sim |
| [002](stories/002-launcher-navigation.story.md) | Launcher Sidebar, Status Bar & Live State |
| [003](stories/003-read-documentation.story.md) | Read the Built-in Documentation |

### Epic 2 — Consume mods (Marketplace & My Mods)
| Story | Title |
| --- | --- |
| [004](stories/004-browse-marketplace.story.md) | Browse the Marketplace Storefront |
| [005](stories/005-view-product-page.story.md) | Evaluate a Mod on its Product Page |
| [006](stories/006-install-mod.story.md) | Install a Mod into DCS |
| [007](stories/007-manage-installed-mods.story.md) | Manage Installed Mods in My Mods |
| [008](stories/008-mymods-shortcut-deeplink.story.md) | Launch My Mods from the Desktop |

### Epic 3 — Author & publish mods
| Story | Title |
| --- | --- |
| [009](stories/009-create-project-from-template.story.md) | Create a Mod Project from a Template |
| [010](stories/010-author-manifest.story.md) | Author the Manifest with the Two-Way Form |
| [011](stories/011-share-mod-to-github.story.md) | Publish: Preflight & Share to GitHub |
| [012](stories/012-cut-release.story.md) | Publish: Package & Cut a Release |

### Epic 4 — Prepare the sim
| Story | Title |
| --- | --- |
| [013](stories/013-missionscripting-sanitization.story.md) | Manage MissionScripting.lua Sanitization |
| [014](stories/014-inject-eject-bridge.story.md) | Inject & Eject the Bridge |
| [015](stories/015-launch-dcs-with-bridge.story.md) | Launch DCS with the Bridge |
| [016](stories/016-build-bridge-from-source.story.md) | Build the Bridge from Source |

### Epic 5 — Work against the live sim
| Story | Title |
| --- | --- |
| [017](stories/017-lua-console.story.md) | Evaluate Lua in the Live Sim (Console) |
| [018](stories/018-state-explorer-export.story.md) | Explore & Export Sim State |
| [019](stories/019-run-lua-in-dcs.story.md) | Run a Lua File in DCS (without debugging) |
| [020](stories/020-debug-lua-breakpoints.story.md) | Debug Lua inside DCS: Breakpoints & Stepping |
| [021](stories/021-debug-inspect-state.story.md) | Debug Lua inside DCS: Inspect & Modify State |
| [022](stories/022-debug-resilience.story.md) | Debug Lua inside DCS: Errors & Sim Safety |

### Epic 6 — AI-assisted development
| Story | Title |
| --- | --- |
| [023](stories/023-manage-agent-skills.story.md) | Manage Agent Skills for the Repo |

## Cross-journey flows

- **Consumer loop:** 001 → 004 → 005 → 006 → 007 (008 makes it app-like).
- **Author loop:** 009 → 010 → 011 → 012 — then the mod appears in 004 for everyone else, because sharing tags the repo with the discovery topic and the release ships the manifest the product page (005) and installer (006) read.
- **Live-dev loop:** 013 (mission env only) → 015 → 017/018 to explore → 019 to iterate → 020–022 to debug.

## Glossary

| Term | Meaning |
| --- | --- |
| **Manifest** | `dcs-studio.toml` — project metadata, `[[install]]` rules, `[[dependencies]]`, `[[requires_module]]` |
| **Named roots** | `{SavedGames}` and `{GameInstall}` — the two anchor points install destinations resolve against |
| **Subscribe / enable** | Download+unpack into the data dir / link the unpacked files into DCS (junction, hard link or symlink) |
| **Bridge** | The `dcs_studio.dll` + GameGUI hook pair serving JSON-RPC over a localhost WebSocket from inside DCS |
| **Environments** | `mission` (sandboxed mission scripting) vs `gui` (GameGUI hooks, `DCS.*`/`net.*`) — plus server/config/export net states in the console |
| **Sanitization** | DCS's stock lockdown of `os`/`io`/`lfs`/`require`/`loadlib`/`package` in the mission environment |
| **Skill** | A committed `SKILL.md` teaching AI coding agents this toolchain |

## Conventions in this spec

- Each story lives in `stories/NNN-<name>.story.md`: a user-story header
  (*As a / I want / so that*), a Context section naming real entry points
  (commands, buttons, settings), and Gherkin `Feature` / `Rule` /
  `Scenario` blocks quoting the application's actual UI strings.
- Scenarios describe the **current shipped behaviour**. Where the codebase
  shows design intent that isn't implemented yet, the story says so in an
  explicit "Design intent" section (see story 005).
