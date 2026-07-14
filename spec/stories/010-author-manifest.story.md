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

  Rule: The form covers every modeled manifest section

    Scenario: Project section
      Then the [project] card offers Name (required), Version, Author,
        and Description fields

    Scenario: Install rules
      Then the [[install]] card lets the user add and remove rules
      And each rule has a project-relative Source,
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
        | an install rule has an empty source      | Install rule N: source is empty.                                 |
        | a {GameInstall} rule with no path set    | Install rule N: {GameInstall} is not configured (set dcsStudio.gameInstallPath). |

    Scenario: Live roots
      When the user changes the DCS path settings
      Then every resolved-path preview updates immediately
```
