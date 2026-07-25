# 018 — Explore & Export Sim State

## Story

> **As a** scripter reverse-engineering DCS state,
> **I want** a single `_G` tree per environment that I can filter, sweep and drill into lazily — with function signatures and per-node JSON export,
> **so that** I can navigate structures like `db`, `Export` or `env.mission` the way I would in dcsfiddle, without writing dump scripts.

## Context

- The **Explorer** tab of the DCS Lua Console (story 017). Uses the same environment picker.
- A single `_G` root per environment — no expression box. Fully lazy; the tree is cached per env (switching env keeps each tree and its live sim-side refs).
- Pure logic (glob matcher, filter modes, match propagation, sweep budget math, copy serialization) lives in `media/explorer-core.js` (`DcsExplorerCore`), vitest-tested.
- Function signatures are resolved sim-side via `repl_signature` — the runtime reads parameter names off a call hook and **never runs the function**.
- Exports are serialized sim-side to a temp file, then saved wherever the user chooses.

```gherkin
Feature: State explorer

  Background:
    Given the DCS Lua Console is open on the Explorer tab
    And the bridge is connected

  Scenario: A single _G root per environment
    When the Explorer tab is first shown for the selected environment
    Then the environment's "_G" is inspected and its top-level keys render
    And switching environments shows that environment's own cached tree

  Scenario: Type icons and previews
    Then each node shows a type icon (chevron for tables, square-function for
      functions, hash for numbers, toggle for booleans, type for strings, box
      otherwise) and an italic muted preview

  Scenario: Lazy drilling; collapse discards children
    When the user expands a table node
    Then its children load on demand,
      sorted numeric keys first then alphabetical,
      capped at 1000 entries with a "…  (truncated)" marker
    And collapsing the node discards its children
    And re-opening it refetches them (self-healing a stale ref)

  @chaos
  Scenario: The table mutated (or its ref was released) between expands
    Given a table node was expanded, then "Refresh" released that environment's refs
    When the ref is expanded again before the tree is rebuilt
    Then the sim answers with an empty variable list rather than an error
    And the node renders "(empty)" — a released ref is indistinguishable from an empty table
    And the row leaves its loading state, so it is never a dead spinner

  @chaos
  Scenario: A table larger than the child cap
    Given a table with more than 1000 keys (db.Weapons.ByCLSID, say)
    When the user expands it
    Then exactly 1000 children render, sorted numeric-first then alphabetically
    And a final row keyed "…" previews "(truncated)"
    And that marker row carries no ref, so it cannot be expanded or exported

  @chaos
  Scenario: A self-referencing table can be drilled forever
    Given a table whose key points back at an ancestor (a cycle in live sim state)
    Then each expand hands out a fresh sim-side ref, so the tree never detects the loop
    And drilling is bounded only by the runtime's 500000-ref ceiling
    When that ceiling is reached
    Then further values come back with no ref and their rows' toggles are disabled,
      rather than the sim's memory growing without bound

  @chaos
  Scenario: An expand that the bridge refuses
    Given the sim rejects the expand (the state went away mid-drill)
    Then the failure renders as an error row under that node
    And the node's spinner clears
    And the rest of the tree — and the other environments' trees — are untouched

  Scenario: Function arity previews and click-to-resolve signatures
    Then a function row previews its arity from debug.getinfo
      (e.g. "function (3 args)", "(2+ args)", "(varargs)", or "(native)")
      without ever calling the function
    When the user clicks a function row
    Then its real parameter names resolve to "name(a, b, c)"
      (a native/C function shows "name()  (native)")

  Scenario: Three-mode live filter keeps ancestors of deep matches
    When the user types in the filter
    Then a filter containing "/" globs the full path (glob subset: * ? **),
      a filter with glob chars globs the basename,
      and a plain filter is a case-insensitive substring
    And matching nodes stay visible along with all their ancestors,
      while unrelated branches hide (nodes stay mounted)

  @chaos
  Scenario Outline: Filters at the extremes
    When the user types "<filter>"
    Then <outcome>

    Examples:
      | filter      | outcome                                                                    |
      |             | nothing is hidden — an empty filter matches every node                     |
      | zzzz        | every node hides, including the "_G" root, leaving a blank tree             |
      | *           | nothing is hidden — every basename matches a single "*"                    |
      | _G/*        | only the depth-1 children match; "_G" stays visible as their ancestor       |
      | _G/db       | "_G/db/Units" hides too — without "**" the pattern must consume every segment |

  @chaos
  Scenario: A filter is matched case-insensitively on purpose
    Given DCS's own keys mix cases wildly ("db", "Units", "DisplayName")
    When the user types "_g/DB/units"
    Then it still matches "_G/db/Units"
    And no character class ("[abc]") or brace expansion ("{a,b}") is honoured —
      those are literal characters, as the filter placeholder says

  Scenario: Enter-triggered path sweep, budget-capped
    Given the filter is a path pattern containing "/"
    When the user presses Enter (or clicks the sweep button)
    Then the tree auto-expands closed table nodes on the path toward a match,
      to a depth from the pattern segments (a "**" costs the
      dcsStudio.explorerWildcardDepth setting, default 1),
      bounded by a 200-fetch budget
    And a notice reports when the 200-fetch limit is hit
    And a bare-word (no "/") Enter shows "use a path pattern with /"
    And a mission-environment sweep warns that it can be slow

  @chaos
  Scenario: A sweep pattern broad enough to walk the whole sim
    Given the filter is "_G/**/*" with the default explorerWildcardDepth of 1
    When the user presses Enter
    Then the sweep spends at most 200 table fetches
    And it stops with the notice "Sweep hit the 200-fetch limit — refine the pattern."
    And whatever it did expand stays expanded and filtered — the tree is not rolled back

  @chaos
  Scenario: A sweep pattern that matches nothing
    Given the filter is "_G/nosuchkey/*"
    When the user presses Enter
    Then no closed node lies on the pattern's prefix, so not one expand is sent
    And the tree ends up entirely hidden by the same filter
    And no notice claims a budget was hit

  @chaos
  Scenario: Editing the filter while a sweep is draining
    Given a sweep is in flight, waiting on the sim thread for the next expand
    When the user types another character into the filter
    Then the in-flight sweep is abandoned at its next step (its generation is stale)
    And already-returned expands are kept — they are real tree state, not sweep state
    And a second Enter starts a fresh sweep rather than compounding the first

  @chaos
  Scenario: The mission ends while its sweep is draining
    Given a mission-environment sweep is expanding nodes
    When the mission ends and the mission bridge goes down
    Then each outstanding expand comes back as a failure and renders under its node
    And the sweep drains to a stop instead of retrying forever
    And the "Mission sweep can be slow — each fetch waits on the sim thread." notice
      is what the user was already warned by

  @chaos
  Scenario: A bare-word sweep is refused with the pattern it needs
    Given the filter is "Units" with no "/"
    Then the sweep button is disabled
    And pressing Enter shows
      "Use a path pattern with / to sweep — e.g. _G/db/Units/*."
    And no expand is sent to the sim

  Scenario: Copy children as JSON
    When the user clicks a loaded table node's copy button
    Then its children are copied to the clipboard as JSON
    And a check icon confirms for about two seconds

  Scenario: Exporting a table to JSON
    When the user hovers a table row and clicks its export button
    Then the sim serializes the full value to pretty JSON
    And a Save dialog proposes a filename derived from the node path
    And after saving, files under 5 MB open in an editor,
      larger ones report "Exported <size> to <path>"

  Scenario: Export failure
    Given serialization fails sim-side
    Then a notice shows "export failed — <message>"

  @chaos
  Scenario: The user cancels the Save dialog
    Given the sim has already serialized the table to its temp file
    When the user dismisses the Save dialog
    Then nothing is written to the workspace
    And the sim's temp file is deleted anyway, so the DCS write dir is not littered
    And the export button re-arms with no "export failed" notice — cancelling is not a failure

  @chaos
  Scenario: The sim's temp file cannot be tidied away
    Given the export was saved successfully
    When deleting the sim-side temp file fails (it is still open, or the share dropped)
    Then the saved file is kept and reported as saved
    And the tidy-up failure is swallowed — it is best-effort, not part of the outcome

  @chaos
  Scenario: The chosen destination cannot be written
    Given the sim serialized the table and the user picked a destination
    When copying to it fails (the disk is full, the path is read-only)
    Then a notice shows "export failed — <message>" and the button re-arms
    And no partial file is presented as a successful export
    But the sim-side temp file is left behind, because the tidy-up step is skipped
      on the failure path
      # UNVERIFIED: no test covers a failing copy; deduced from the tidy-up
      # `delete` sitting after the copy inside the same try block

  @chaos
  Scenario: An export exactly at the open limit
    Given the serialized JSON is exactly 5 MB
    Then it is announced as "Exported <size> to <path>" rather than opened —
      the limit is "smaller than 5 MB opens", so 5 MB itself does not
    And an export one byte smaller does open in an editor tab

  @chaos
  Scenario: The destination file already exists
    Given the user picks a path that already holds an earlier export
    Then the OS Save dialog is what asks about replacing it
    And once confirmed the copy overwrites, rather than failing with "file exists"

  @chaos
  Scenario: Exporting a node the sim holds no ref for
    Given a table row whose ref is 0 (the ref ceiling was reached, or the state was reset)
    When the user exports it
    Then the request falls back to the node's tree path as a Lua expression
    And a path like "_G/db/Units" is not the expression the user meant,
      so the export fails with the sim's error and the button re-arms
      # UNVERIFIED: exact message — "_G/db/Units" parses as arithmetic, so it
      # fails at run time rather than at loadstring; no test covers this fallback

  Scenario: Refresh releases sim resources
    When the user clicks "Refresh"
    Then the selected environment's tree is dropped and its sim-side refs released
    And "_G" is re-inspected fresh

  @chaos
  Scenario: Refresh while the selected environment's bridge is down
    Given the GUI bridge went offline after the tree was loaded
    Then the filter, sweep and refresh controls are all disabled
    And a click that still reaches the handler is ignored —
      clearing a tree that cannot be re-read would leave an Explorer with no way back

  @chaos
  Scenario: Releasing refs in an environment that is already gone
    Given a release is requested across both "GUI (hooks)" and "Mission (scripting env)"
    When the mission has ended, so its bridge refuses the call
    Then that failure is ignored — a finished mission took its refs with it
    And the GUI environment's refs are still released, not abandoned mid-list

  Rule: Sim-side writes never escape the DCS write root

    The bridge writes exports (and every other `file.*`/`sqlite` write) under
    `lfs.writedir()` through one lexical guard. It is a security boundary: the
    destination arrives over a local JSON-RPC surface, and anything that escapes
    is an arbitrary-file-write primitive on the user's machine. The guard parses
    with Windows semantics on every host, so it behaves the same on CI as in DCS.

    @chaos
    Scenario Outline: A destination that leaves the write root is refused
      When the sim is asked to write to "<path>"
      Then the write is refused before any file is opened
      And the caller gets "path escapes the write root: <path>"
      And the error names no part of the write root's real location

      Examples:
        | path                                        | why                                  |
        | ../secrets                                  | parent traversal                     |
        | ..\secrets                                  | parent traversal, Windows separator  |
        | Logs/../../secrets                          | traversal buried mid-path            |
        | /etc/passwd                                 | rooted                               |
        | \Windows\System32                           | rooted, Windows separator            |
        | \\server\share\x                            | UNC path                             |
        | C:\Windows\System32\drivers\etc\hosts       | drive-prefixed absolute              |
        | C:relative                                  | drive-prefixed relative              |
        | notes.txt:hidden                            | NTFS alternate data stream           |
        | a/b.txt:$DATA                               | NTFS alternate data stream           |
        |                                             | empty                                |
        | .                                           | names the root itself, not a path under it |
        | a//b                                        | doubled separator, refused not normalised |
        | a/                                          | trailing separator                   |

    @chaos
    Scenario: Ordinary relative destinations still work
      Then "Temp/dcs-studio-export-1.json", "Logs\dcs.log", "./dcs.log" and "a/./b"
        all resolve under the write root
      And missing parent directories are created on the way

    @chaos
    Scenario: The guard runs before the write root is even resolved
      Given lfs.writedir() is unavailable in the target state
      When an escaping path is submitted
      Then the failure is the escape, not "lfs.writedir() unavailable" —
        so a rejection can never leak where the write root is
```
