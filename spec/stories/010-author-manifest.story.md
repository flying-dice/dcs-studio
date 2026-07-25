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
      And when the debounce fires it emits the re-seeded text, which equals
        the document, so the host applies no edit
      And the user's keystroke is lost silently
        # UNVERIFIED: read off the debounce closure in media/manifest.js re-reading state.model at fire time and formPanel.ts skipping an identical edit; no test drives the two events into that window

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
    Scenario: A [project] name written as a TOML number breaks the form
      Given the manifest carries name = 2024 — a valid TOML integer,
        not a quoted string
      Then the validation pass throws, because it calls trim() on a number
      And the issues box stays empty — neither "Manifest looks valid."
        nor any issue is shown
      And every subsequent form edit is silently dropped: the emit that
        would push it to the document never runs
      And typing into the Name field is the only way out, because that
        assigns a string back over the number
        # UNVERIFIED: the TypeError is confirmed by evaluating media/manifest-core.js and media/manifest.js's issues() directly; the exact rendered state of the panel after the throw was not observed in a browser

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
