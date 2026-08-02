# 010 — Author the Manifest with the Two-Way Form

## Story

> **As a** mod author,
> **I want** a form view of `dcs-studio.toml` that stays two-way bound to the raw TOML editor, with live validation and resolved install paths,
> **so that** I can edit the manifest without memorising the format, while power users keep full text control.

## Context

- Entry points: command **"DCS Studio: Open Manifest Form (beside editor)"** (`dcs.manifest.openForm`), the form icon in the editor title of any `dcs-studio.toml`, and automatic opening — the form appears beside the editor whenever a `dcs-studio.toml` is opened. **"Create a Mod"** (`dcs.manifest.author`) opens the split view when a manifest already exists.
- The open document is the source of truth: the form emits TOML into the document; saving, dirty state and undo are VS Code's own.

```gherkin
Feature: Manifest form panel

  Background:
    Given a "dcs-studio.toml" is open in a text editor
    And the manifest form is open beside it

  Rule: The form and the text editor are two-way bound

    Scenario: Form edits flow into the document
      When the user edits a field in the form
      Then the document updates with the emitted TOML (debounced)
      And Ctrl/Cmd+S saves through VS Code as normal

    Scenario: Text edits flow into the form
      When the user edits the TOML directly, undoes, or reverts
      Then the form re-seeds from the document without stealing focus

    Scenario: The form follows the document lifecycle
      When the manifest's text editor is closed
      Then the form panel closes too

    @chaos
    Scenario: Malformed TOML while the user is typing in the editor
      Given the user is midway through typing a line in the raw TOML
      Then the form re-seeds anyway — the parser is deliberately tolerant
        and never throws
      And a line that is not "key = value" is ignored rather than reported
      And no error banner appears; the issues box reports only
        what the modeled sections are missing

    @chaos
    Scenario: A file that is not TOML at all
      Given "dcs-studio.toml" contains no recognisable section headers
      When the form opens beside it
      Then the form draws with every card empty rather than refusing to open
      And the issues box lists "Project name is required."
      And nothing is written back until the user edits something

    @chaos
    Scenario: An external edit lands while a form keystroke is still debounced
      Given the user has changed a form field and the 200ms debounce
        has not yet fired
      When the document changes from outside — a raw-text edit, an undo,
        or a revert
      Then the form re-seeds from the document, discarding the pending change
      And the pending debounce timer is cancelled outright when the external
        change arrives, so the form's stale model is never emitted
      And the user's keystroke is lost silently

    @chaos
    Scenario: The form's own edit is not fed back to it
      When the form's emitted TOML returns through the document-change event
      Then it is recognised as the form's own echo and not re-seeded —
        re-seeding would clobber the field the user is still typing in
      And as soon as the document diverges from what the form last wrote,
        re-seeding resumes

    @chaos
    Scenario: An edit identical to the document is dropped
      When the debounce fires with text the document already holds
      Then no workspace edit is applied
      And the file is not marked dirty for nothing

    @chaos
    Scenario: Opening the form twice for one document
      When the form is requested again for a manifest that already has one
      Then the existing panel is revealed rather than a second one created —
        two forms bound to one document would fight over every keystroke
      And a different manifest still gets its own form

  Rule: The form covers every modeled manifest section

    Scenario: Project section
      Then the [project] card offers Name (required), Version, Author,
        and Description fields

    Scenario: Bundle and symlink rules
      Then the [[bundle]] card lets the user add and remove paths packed
        into the release
      And the [[symlink]] card lets the user add and remove link rules
      And each symlink rule has a project-relative Source,
        a root selector ({SavedGames} or {GameInstall}) plus a rest path,
        and a live "→ <resolved absolute path>" preview
      And a rule under {GameInstall} with no configured game install path
        shows "⚠ {GameInstall} not configured"

    Scenario: Executables
      Then the Executables ([[entrypoint]]) card lets the user add and remove
        entries with an id and an exe path
      And validation flags "Executable N: exe is not inside any bundled path."
        and "Executable N: duplicate id \"<id>\"."

    Scenario: Mission scripts
      Then the Mission scripts ([[mission_script]]) card lets the user add and
        remove entries
      And validation flags an empty name/path and a script not inside any
        bundled path

    Scenario: Required modules
      Then the [[requires_module]] card captures a Module id and optional Name
      And the blurb explains it is "A presence check only — never installed,
        only warned about."

    Scenario: Unmodeled sections are preserved
      Given the file has sections the form doesn't edit
      Then a "Preserved sections" card explains they are kept exactly
        as written and saved back untouched

    @chaos
    Scenario: Comments are not preserved, only unmodeled sections are
      Given a freshly scaffolded manifest, which opens with a commented
        header block above [project] and explanatory comments between
        the modeled sections
      When the user changes any field in the form
      Then every one of those comments is gone from the document —
        lines before the first section header are dropped, and comment
        lines inside a modeled section are stripped
      And the commented-out [[bundle]]/[[symlink]] examples the Blank
        Project template ships are lost with them
      But an unmodeled section's own comments survive, because that whole
        block is captured verbatim

    @chaos
    Scenario: A preserved section is re-emitted at the end of the file
      Given an unmodeled section such as [format] appears above [project]
      When the form emits the document
      Then the block's text is byte-for-byte what it was
      But it now sits after every modeled section — preservation is
        of content, not of position

    @chaos
    Scenario: A manifest with no version gains one
      Given "dcs-studio.toml" has a [project] block with no version key
      When the form emits the document
      Then version = "0.1.0" appears, because the form's empty model
        carries that default
      And the user sees a key they never wrote

  Rule: Validation is live and advisory

    Scenario: Valid manifest
      Then the issues box reads "Manifest looks valid."

    Scenario Outline: Issues are listed but never block saving
      Given <condition>
      Then the issues box lists "<issue>"
      And the document still saves normally

      Examples:
        | condition                                | issue                                                            |
        | the project name is blank                | Project name is required.                                        |
        | a symlink rule has an empty source        | Symlink N: source is empty.                                      |
        | a {GameInstall} rule with no path set    | Symlink N: {GameInstall} is not configured (set dcsStudio.gameInstallPath). |

    Scenario: Live roots
      When the user changes the DCS path settings
      Then every resolved-path preview updates immediately

    @chaos
    Scenario Outline: A [project] scalar written as a bare TOML value
      Given the manifest carries <field> = <written> — valid TOML,
        but not a quoted string
      Then the parser normalises the modeled [project] scalars to their
        literal text, so the form is handed "<shown>"
      And the field shows <shown> and the issues box reports on it like
        any other value — no throw, nothing left blank
      And the form stays live: a later keystroke still reaches
        the document
      And the emitted document settles on <field> = "<shown>",
        which reparses to the same thing

      Examples:
        | field       | written | shown |
        | name        | 2024    | 2024  |
        | version     | 3       | 3     |
        | author      | true    | true  |
        | description | 1.5     | 1.5   |

    @chaos
    Scenario Outline: An array-section field written as a bare TOML value
      Given the manifest carries <section> with <field> = 2024
      Then the parser normalises it to the literal text "2024" too,
        exactly as it does for the [project] scalars
      And the form renders that row and validates it like any other —
        no throw while the template is being built
      Because the form assigns its model before rendering, so one
        numeric row would otherwise leave the whole form blank and
        every later message would re-throw on the same row

      Examples:
        | section            | field   |
        | [[bundle]]         | path    |
        | [[symlink]]        | dest    |
        | [[entrypoint]]     | exe     |
        | [[mission_script]] | path    |

    @chaos
    Scenario: An unmodeled key keeps its TOML type
      Given the manifest carries dcs_min_version = 2 under [project]
      When the form emits the document
      Then it is written back unquoted, as the integer it was —
        only the fields the form models are normalised to text

    @chaos
    Scenario: A symlink destination that reaches outside the DCS folders
      Given a [[symlink]] whose dest is "{SavedGames}/../../evil.lua"
      Then the resolved-path preview shows
        "Reaches outside the DCS folders" instead of a path
      And the issues box lists
        "Symlink N: destination reaches outside the DCS folders."
      Because a dest that escapes is refused at install time on every
        machine — it is an authoring error, not a machine-local one,
        so it is stated as such rather than as a settings problem
      And the same verdict is reached for a drive-prefixed dest
        such as "C:/Windows/System32/x.dll", an NTFS alternate stream,
        and a dest using backslash separators — the rule is the
        bridge's own path guard, mirrored here

    @chaos
    Scenario: Rows added but not filled in
      When the user clicks "Add bundled path", "Add symlink" and
        "Add required module" without typing anything
      Then the issues box lists
        "Bundle 1: path is empty.",
        "Symlink 1: source is empty."
        and "Required module 1: id is empty."
      And the document still saves — the form never blocks a write
      And the empty rows are emitted as real TOML blocks, so the raw
        editor shows them too

    @chaos
    Scenario: A symlink source outside every bundled path
      Given a [[symlink]] whose source no [[bundle]] path covers
      Then the issues box lists
        "Symlink N: source is not inside any bundled path."
      Because a link created on enable would point at a file the
        release payload never shipped

    @chaos
    Scenario: Hostile-looking text in a field is escaped, never executed
      Given the user pastes markup such as <img src=x onerror=alert(1)>
        into the Description field
      Then it renders as literal text in the form and in the TOML preview
      And it is emitted into the document as a quoted TOML string,
        with backslashes and double quotes escaped

    @chaos
    Scenario: Duplicate executable ids
      Given two [[entrypoint]] blocks declare the same id
      Then the issues box lists 'Executable 2: duplicate id "<id>".'
      Because the two would collide in My Mods' running-process map
      And the document still saves
```
