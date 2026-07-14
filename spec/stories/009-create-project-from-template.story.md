# 009 — Create a Mod Project from a Template

## Story

> **As a** mod author starting a new DCS mod,
> **I want** to scaffold a project from a template — into a new folder or bootstrapped into the folder I already have open,
> **so that** I begin with a valid manifest, a working entry point and correct install rules instead of a blank directory.

## Context

- Entry points: command **"DCS Studio: New Project from Template…"** (`dcs.project.new`); **"DCS Studio: Create a Mod (manifest or new project)"** (`dcs.manifest.author`) opens this panel when the workspace has no `dcs-studio.toml` (otherwise it opens the manifest editor, story 010); the **Create a Mod** launcher row.
- Nothing is installed into DCS by scaffolding — files are only written where the panel shows.

```gherkin
Feature: New Project panel

  Background:
    Given the user opens the "New Project" panel

  Rule: Four templates cover the common mod shapes

    Scenario: Template tiles
      Then the panel offers, with the first selected by default:
        | Template            | Description                                                                  |
        | Blank Project       | Just a dcs-studio.toml manifest — bring your own structure.                  |
        | Lua Mission Script  | Runs in the mission scripting environment — loaded by a mission trigger.     |
        | Lua GameGUI Hook    | Runs in the GUI environment — auto-loaded from Scripts/Hooks at DCS start.   |
        | Rust DLL Mod        | Native mod: cargo project building a DLL, deployed via install rules.        |

    Scenario Outline: What each template scaffolds
      When the user creates a project named "my mod" from "<template>"
      Then the project contains <files>
      And every manifest has a [project] block seeded with the name,
        version 0.1.0 and dcs_min_version 2.9.0

      Examples:
        | template           | files                                                                                      |
        | Blank Project      | dcs-studio.toml only, with commented [[bundle]]/[[symlink]] examples   |
        | Lua Mission Script | dcs-studio.toml, Scripts/my-mod.lua sample, README.md; bundle + symlink rule → {SavedGames}/Scripts |
        | Lua GameGUI Hook   | dcs-studio.toml, Scripts/Hooks/<ident>_hook.lua, README.md; bundle + symlink rule → {SavedGames}/Scripts/Hooks |
        | Rust DLL Mod       | dcs-studio.toml (DLL + hook bundle/symlink rules), Cargo.toml, .cargo/config.toml, lua5.1/lua.lib, src/lib.rs, Scripts/Hooks/<ident>_hook.lua, README.md |

    Scenario: Names become safe identifiers
      Given the project name contains spaces or punctuation
      Then folder and file slugs are lowercased with hyphens
      And Lua/Rust identifiers are keyword- and digit-safe

  Rule: Destination adapts to whether a folder is open

    Scenario: A workspace folder is open
      Then the Destination section offers two modes:
        "Use the open folder" (default) — "The template is bootstrapped into the open folder; files you already have are kept."
        and "Create a new folder" — "A fresh folder under a location you pick, opened when ready."
      And the Name field is prefilled from the folder basename

    Scenario: No folder is open
      Then only new-folder mode is available
      And the user must pick a Location (Browse… opens a native folder picker)
      And the default location suggestion is the last-used location or ~/DCSStudio

    Scenario: Live path preview
      Then the panel previews where files will be written as "→ <path>"
      And the "Create Project" button stays disabled until
        the name and destination are valid

  Rule: Creation is safe and hands off into authoring

    Scenario: Creating into a new folder
      When the user clicks "Create Project" in new-folder mode
      Then the button shows "Creating…"
      And the new folder is created and opened in the window
      And after the reload the manifest opens with the form beside it

    Scenario: Bootstrapping in place keeps existing files
      Given the open folder already contains some template files
      When the user creates in-place
      Then only missing files are written
      And a message reports
        "Kept N existing file(s) the template also provides: …"
      And the manifest editor opens

    Scenario Outline: Validation errors
      When the input is <problem>
      Then an inline error shows "<message>"

      Examples:
        | problem                       | message                                        |
        | empty name                    | Enter a project name.                          |
        | invalid folder name           | "<name>" isn't a valid folder name.            |
        | no location chosen            | Choose a location for the project.             |
        | target folder exists non-empty | "<root>" already exists and isn't empty.      |
```
