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

  Rule: Five templates cover the common mod shapes

    Scenario: Template tiles
      Then the panel offers, with the first selected by default:
        | Template            | Description                                                                  |
        | Blank Project       | Just a dcs-studio.toml manifest — bring your own structure.                  |
        | Lua Mission Script  | Runs in the mission scripting environment — loaded by a mission trigger.     |
        | Lua GameGUI Hook    | Runs in the GUI environment — auto-loaded from Scripts/Hooks at DCS start.   |
        | Rust DLL Mod        | Native mod: cargo project building a DLL, bundled and symlinked into DCS.    |
        | Share a Mission     | Package a .miz and link it into your DCS user Missions folder.               |

    Scenario Outline: What each template scaffolds
      When the user creates a project named "my mod" from "<template>"
      Then the project contains <files>
      And every manifest has a [project] block seeded with the name,
        version 0.1.0, dcs_min_version 2.9.0, empty author and description,
        and template = "<template id>"

      Examples:
        | template           | files                                                                                      |
        | Blank Project      | dcs-studio.toml only, with commented [[bundle]]/[[symlink]] examples   |
        | Lua Mission Script | dcs-studio.toml, Scripts/my-mod.lua sample, README.md; bundle + symlink rule → {SavedGames}/Scripts |
        | Lua GameGUI Hook   | dcs-studio.toml, Scripts/Hooks/<ident>_hook.lua, README.md; bundle + symlink rule → {SavedGames}/Scripts/Hooks |
        | Rust DLL Mod       | dcs-studio.toml (DLL + hook bundle/symlink rules), Cargo.toml, .cargo/config.toml, lua5.1/lua.lib, src/lib.rs, Scripts/Hooks/<ident>_hook.lua, README.md |
        | Share a Mission    | dcs-studio.toml, Missions/README.md; bundle + symlink rule → {SavedGames}/Missions/<slug>.miz |

    Scenario: Names become safe identifiers
      Given the project name contains spaces or punctuation
      Then folder and file slugs are lowercased with hyphens
      And Lua/Rust identifiers are keyword- and digit-safe

    @chaos
    Scenario: A name with no ASCII letters or digits
      Given the project name is "Миссия"
      When the user creates a project from "Lua Mission Script"
      Then the folder is named "Миссия" exactly as typed
      And every slug and identifier falls back to "untitled",
        so the script is written to Scripts/untitled.lua
      And the manifest still carries name = "Миссия"

  Rule: Destination adapts to whether a folder is open

    Scenario: A workspace folder is open
      Then the Destination section offers two modes:
        "Use the open folder" (default) — "The template is bootstrapped into the open folder; files you already have are kept."
        and "Create a new folder" — "A fresh folder under a location you pick, opened when ready."
      And the Name field is prefilled from the folder basename

    Scenario: No folder is open
      Then only new-folder mode is available
      And the user must pick a Location (Browse… opens a native folder picker)
      And the Location starts empty, showing
        "Choose where to create the project…"
      And the picker opens at the last-used location, else ~/DCSStudio
      # The last-used/~/DCSStudio value only prefills the field when a
      # folder IS open; with no folder it seeds the picker's start directory.

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

    @chaos
    Scenario: The target path is an existing file
      Given a file — not a folder — already sits at the previewed path
      When the user clicks "Create Project" in new-folder mode
      Then the inline error reads "<root>" already exists.
      And it is worded differently from the non-empty-folder case,
        because a file at that path is not something the user can empty out
      And nothing is written

    @chaos
    Scenario Outline: Names Windows cannot make a folder from
      Given the project name is "<name>"
      When the user clicks "Create Project" in new-folder mode
      Then the inline error reads "<name>" isn't a valid folder name.
      And nothing is written

      Examples: characters the name may never contain
        | name        |
        | bad<name    |
        | bad>name    |
        | bad:name    |
        | bad"name    |
        | mods/my-mod |
        | mods\my-mod |
        | bad\|name    |
        | bad?name    |
        | bad*name    |

    @chaos
    Scenario: Endings and control characters Windows cannot keep
      Then a name ending in a dot, a name ending in a space,
        and a name containing any control character (U+0000–U+001F)
        are each rejected with "<name>" isn't a valid folder name.
      And a leading dot and inner dots are fine — ".hidden" and "v1.2.3-x" pass

    @chaos
    Scenario: Create is not gated on a template being selected
      Given the host sent an empty template list, so no tile is selected
      When the user types a name, picks a location and clicks "Create Project"
      Then the panel still enables the button and posts a create
        with an empty template id — the enable rule checks only
        the name and the destination
      And the scaffolder rejects it with Unknown template "".
      And nothing is written

    @chaos
    Scenario: An unknown template is rejected before anything touches disk
      Given the requested template id is not one the extension renders
      When the user clicks "Create Project"
      Then the inline error reads Unknown template "<template>".
      And the target folder is never created

    @chaos
    Scenario: A write failing partway leaves the folder blocking its own retry
      Given the target folder is created and the first files are written
      When a later write fails — the disk fills, or the folder loses write permission
      Then the inline error carries the platform's own message
      And the files already written stay on disk — there is no rollback
      And the panel stays open with "Create Project" re-armed
      But retrying the same name now fails with
        "<root>" already exists and isn't empty.
      And the user must empty or rename the folder by hand to get any further

    @chaos
    Scenario: The location is not writable
      Given the chosen location cannot be written to
      When the user clicks "Create Project"
      Then the panel keeps the form and shows the host's message inline
      And "Create Project" re-arms so the user can pick another location
      And editing the name or switching destination clears the stale error

    @chaos
    Scenario: Create cannot be fired twice
      When the user clicks "Create Project" and then clicks again,
        or presses Enter in the Name field, while it still reads "Creating…"
      Then only one create is posted
      And a success does not re-arm the button — the host tears the panel down

    @chaos
    Scenario: A failure the host cannot describe
      Given the scaffold fails with a value that is not an Error
      Then the inline error still says something —
        the message text, or "Something went wrong." when there is none

    @chaos
    Scenario: Bootstrapping in place still refuses an empty name
      Given a workspace folder is open and in-place mode is selected
      When the user submits a whitespace-only name
      Then the error reads "Enter a project name."
      And nothing is written into the open folder

    @chaos
    Scenario: Bootstrapping in place when the folder already has every template file
      Given the open folder already contains every file the template provides
      When the user creates in-place
      Then no file is written and none is overwritten
      And the message names all of them:
        "Kept N existing file(s) the template also provides: …"
      And the manifest editor still opens

    @chaos
    Scenario: In-place accepts a name a folder could not have
      Given a workspace folder is open and in-place mode is selected
      When the user creates a project named "My Mod: Reloaded"
      Then it is accepted — no folder is being created from the name
      And the manifest carries name = "My Mod: Reloaded"

    @chaos
    Scenario: The reload lands somewhere other than the new project
      Given a project was scaffolded into a new folder
      And a pending-open breadcrumb was written before the window reloaded
      When the reloaded window's first folder is not that project root
      Then the breadcrumb is discarded rather than reused later
      And the manifest and form do not open
      But the scaffolded files are all on disk and intact

  Rule: Names the folder validator does not catch surface as the platform's own error

    @chaos
    Scenario Outline: Windows reserved device names pass validation
      Given the project name is "<name>"
      When the user clicks "Create Project" in new-folder mode
      Then the name passes the folder-name check —
        reserved device names are not in the rejected set
      And the failure surfaces later as the filesystem's own error
        in the panel's inline error box # UNVERIFIED: no reserved-name guard exists in scaffoldPlan.ts; the exact message comes from Windows via vscode.workspace.fs and was not observed

      Examples:
        | name |
        | CON  |
        | PRN  |
        | NUL  |
        | COM1 |

    @chaos
    Scenario: A target path longer than the Windows path limit
      Given the location plus the project name plus the deepest template path
        exceeds the Windows maximum path length
      When the user clicks "Create Project"
      Then no length check rejects it up front
      And the write fails partway with the filesystem's own error,
        leaving the partially-written folder behind # UNVERIFIED: no path-length guard exists; behaviour inferred from the unrolled-back write loop in src/project/scaffold.ts
```
