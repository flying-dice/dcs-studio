# 024 — Tail dcs.log (DCS Log Viewer)

## Story

> **As a** mod author debugging load failures or script errors,
> **I want** a live-tailed view of DCS's own log with filters for the current mod, level and free text,
> **so that** I can see `log.write`/`env.info` output and errors without the bridge — dcs.log works even when DCS isn't running the bridge at all.

## Context

- Entry points: command **"DCS Studio: Open DCS Log Viewer"** (`dcs.log.open`) and the **DCS Log** launcher row (after DCS Console).
- Distinct from the **DCS Console** (story 017): that streams the bridge's in-memory `print` ring buffer and needs the bridge injected and running. This panel reads `Saved Games/DCS/Logs/dcs.log` straight off disk — no bridge required — and survives DCS restarts (the file gets truncated; the panel notices and keeps tailing).
- Current-mod identity comes from the workspace's `dcs-studio.toml`: lua-hook/rust-dll mods log via `log.write(slug, ...)` (subsystem == slug); lua-mission scripts log via `env.info("[name] ...")` (subsystem `SCRIPTING`, message tagged `[name]`). No manifest, or no `project.name` ⇒ the "My mod" filter is simply absent — not an error state.

```gherkin
Feature: DCS Log viewer

  Background:
    Given the user opens the DCS Log Viewer

  Rule: The log tails from disk, independent of the bridge

    Scenario: Backfill on open
      Then the last portion of dcs.log is shown immediately, oldest first

    Scenario: New lines stream in
      When a script in DCS calls log.write(...) or env.info(...)
      Then the new line appears in the panel within about half a second

    Scenario: dcs.log is missing
      Then a hint pane explains dcs.log wasn't found, referencing the
        configured Saved Games path
      And an "Open Settings" button opens DCS Studio's settings
      When the file later appears
      Then the hint pane is replaced by the live tail, backfilled

    Scenario: DCS restarts (dcs.log is truncated)
      Then a "log restarted" divider appears
      And tailing resumes from the fresh file

    @chaos
    Scenario Outline: The path stats but cannot be read
      Given the configured Saved Games path resolves to <case>
      Then the tick is treated exactly like a missing file: state "missing", hint pane shown
      And the 500 ms poll keeps running rather than dying on an unhandled rejection
      When the path later becomes a readable file
      Then the state returns to "ok" and the tail backfills from it

      Examples:
        | case                                                    |
        | a directory named dcs.log                               |
        | dcs.log deleted between the stat and the open           |
        | a network share that dropped after the stat             |

    @chaos
    Scenario: A single read fails on an otherwise unchanged dcs.log
      Given the tail was reading dcs.log and one tick's open or read failed
        (the stat/open race, a share dropping for a moment)
      Then that tick reports the file as "missing" but keeps its place in it
      When the very next tick stats and reads the same, unchanged file
      Then it resumes from the same offset — the last 256 KiB is NOT read again
      And no line already on screen appears a second time
      And no "log restarted" divider appears, because nothing restarted
      # "ok" is only announced once a read has actually worked, so a path that
      # stats but can never be read reports missing steadily rather than
      # flapping between the two states on every tick.

    @chaos
    Scenario: dcs.log disappears for a while
      Given the tail was reading dcs.log and the file itself goes away
      Then the read offset is discarded and the viewer is told the tail broke —
        exactly once, however many ticks the gap lasts
      When the file comes back
      Then the last 256 KiB is backfilled from it under a "log restarted" divider,
        replacing what the viewer had rather than piling up underneath it

    @chaos
    Scenario: The log is rotated rather than truncated
      Given DCS (or a housekeeping script) renames dcs.log away and starts a fresh one
      Then the replacement is recognised by its identity, not by its size: a
        different inode behind the same path is a restart
      And that holds even when the new file is BIGGER than the old read offset,
        which a size comparison alone cannot see
      And "log restarted" is reported before its lines, so two files' contents
        are never run together
      But where the filesystem reports no usable inode (0 on some Windows
        shares) the size comparison is the only signal left, and a rotate that
        regrows past the old offset between two polls stays undetectable

    @chaos
    Scenario: A line split across a read boundary
      Given a poll's 1 MiB read slice ends in the middle of a log line
      Then the partial line is held back, not rendered as a truncated entry
      And it is emitted complete once the rest of it arrives on a later tick

    @chaos
    Scenario: A multi-byte character split across a read boundary
      Given a UTF-8 sequence (an accented name, a Cyrillic mission title) straddles
        the end of a read slice
      Then the incomplete bytes are carried into the next slice
      And the line renders with the character intact, not as two mojibake halves

    @chaos
    Scenario: A byte sequence that is not valid UTF-8
      Given dcs.log contains a byte run that is not valid UTF-8 (a mod logging raw bytes)
      Then it decodes to replacement characters rather than aborting the read
      And the tail keeps going from the next line
        # UNVERIFIED: no test feeds invalid UTF-8; deduced from the tailer
        # decoding through Node's StringDecoder

    @chaos
    Scenario: A single line larger than a read slice
      Given a script logs one enormous line (a whole table dump on one line)
      Then nothing of it renders until its terminating newline is read
      And it then lands as a single entry
      And no line is ever emitted with a partial tail

    @chaos
    Scenario: dcs.log grows in bursts faster than the poll
      Given a mission load appends several MB between two ticks
      Then each tick reads at most 1 MiB, so the panel fills over a few ticks
        instead of blocking the extension host on one huge read
      And a tick that is still reading is never re-entered by the next one,
        so no line is ever delivered twice

    @chaos
    Scenario: The Saved Games path changes while tailing
      When "dcsStudio.savedGamesPath" is changed
      Then the old tailer is stopped and a new one starts on the new path
      And the buffer is emptied — entries from the old install belong to a different DCS
      And any other setting changing leaves the tail alone

  Rule: Filters narrow what's shown, without re-reading the file

    Scenario: Level filter
      Given all five level chips (INFO/WARNING/ERROR/DEBUG/ALERT) start active
      When the user toggles a level chip off
      Then matching rows hide immediately (already-buffered lines, no host round trip)
      And toggling it back on shows them again

    Scenario: "My mod" filter
      Given the workspace has a dcs-studio.toml with a project name
      Then a "My mod: <name>" toggle is available
      When enabled
      Then only rows whose subsystem matches the project's slug, or whose
        message contains "[<name>]", remain visible

    Scenario: No manifest — no "My mod" filter
      Given the workspace has no dcs-studio.toml (or no project name)
      Then the "My mod" toggle is absent, with no error shown

    Scenario: Free-text filter
      When the user types plain text
      Then only rows whose message contains it (case-insensitive) remain visible
      When the user types "/pattern/"
      Then rows are matched against pattern as a regular expression instead
      When the pattern is invalid
      Then the filter input is flagged (red outline) and nothing is hidden by it

    @chaos
    Scenario: Every level chip turned off
      Given all five level chips are toggled off
      Then rows carrying one of the five levels all hide
      But rows with no level at all — the "=== Log opened UTC …" preamble, and any
        continuation promoted to an entry because the buffer was empty — stay visible
      And toggling a chip back on restores its rows without re-reading the file

    @chaos
    Scenario Outline: Filter text that is hostile rather than merely wrong
      When the user types <input>
      Then <outcome>

      Examples:
        | input                     | outcome                                                          |
        | /(/                       | the input is flagged red and no row is hidden by the text filter  |
        | //                        | an empty pattern matches every row, hiding nothing                |
        | /.*/                      | every row matches, hiding nothing                                 |
        | a very long paste         | it is matched as a plain substring and simply matches nothing     |
        | /[a-/                     | the input is flagged red and no row is hidden by the text filter  |

    @chaos
    Scenario: The manifest names a mod but no line ever matches it
      Given the workspace's project name matches no subsystem and no "[name]" tag in the log
      When the "My mod" filter is enabled
      Then every row hides and the panel shows an empty grid
      And turning the filter back off restores them all — nothing was dropped, only hidden

    @chaos
    Scenario: The manifest is malformed
      Given dcs-studio.toml exists but does not parse
      Then the "My mod" toggle is simply absent, with no error shown
      And the tail still starts — a half-written manifest never stops the log opening

  Rule: Continuations (stack traces, preamble) stay attached to their entry

    Scenario: A multi-line error
      Given an ERROR line is followed by indented stack-trace lines
      Then the stack trace renders indented directly under that entry
      And it shows/hides together with its parent when filters change

  Rule: Scrolling behaves like a live console

    Scenario: Autoscroll while at the bottom
      Then new lines keep the view pinned to the bottom

    Scenario: Pausing to read
      When the user scrolls up
      Then autoscroll pauses and a "↓ N new" pill appears as more lines arrive
      When the user clicks the pill (or scrolls back to the bottom)
      Then the view jumps to the bottom and autoscroll resumes

  Rule: The buffer is bounded

    Scenario: Very high log volume
      Given more than 5000 lines have streamed in
      Then the oldest are dropped and a "N dropped" indicator reflects the count

    Scenario: Clear
      When the user clicks Clear
      Then the panel empties (the host's own tail cursor is unaffected — the
        next appended line still starts right after where tailing left off)

    @chaos
    Scenario: A stack trace arriving before any entry
      Given the very first line read is a continuation (a traceback, or the
        "=== Log opened UTC …" preamble) with no entry to attach to
      Then it is promoted to a standalone entry rather than being discarded
      And it carries no time, level or subsystem

    @chaos
    Scenario: Clear then reopen
      Given the user clicked Clear and more lines have since streamed in
      When the webview reloads and re-handshakes
      Then only the lines that arrived after the Clear come back —
        the cleared backlog is not resurrected
      And the dropped counter starts again from zero

  Rule: Closing the panel really stops the work behind it

    @chaos
    Scenario: Closed before the first tail ever starts
      Given the panel's first tail is queued behind the async workspace-manifest read
      When the user closes the panel inside that window
      Then no tailer is created at all —
        an orphan would keep polling dcs.log every 500 ms for the rest of the session

    @chaos
    Scenario: Closed mid-read
      Given a poll tick is in the middle of reading a slice of dcs.log
      When the user closes the panel
      Then the poll timer is cleared, so no further tick is scheduled
      And the in-flight read's result is posted to a disposed webview and simply
        goes nowhere — it neither throws nor revives the panel

    @chaos
    Scenario: Reopened after closing
      When the user runs "DCS Studio: Open DCS Log Viewer" again
      Then a fresh panel and a fresh tail start, backfilled from the current tail
      And opening it a second time while already open reveals the existing panel
        rather than starting a second tail of the same file
```

## Design notes

- **Split**: `src/core/domain/dcsLog.ts` is pure — line parsing (`parseDcsLogLine`), chunk-to-line decoding (`LineDecoder`), mod-identity matching (`modIdentity`/`matchesMod`), and the bounded ring (`LogBuffer`) — with 100% per-file test coverage. `src/log/tailer.ts` (`LogTailer`) is the only place touching the filesystem: 500 ms `stat` polling, 256 KiB backfill, ≤1 MiB reads per tick, truncation-by-size-shrink detection (DCS restarts truncate; Windows gives no reliable rotation signal, so a rotate-then-regrow between ticks is undetectable — accepted). `src/log/logPanel.ts` (`LogPanel`) wires the tailer to a `ConsolePanel`-shaped singleton webview and resolves "my mod" from the workspace manifest. `media/log.js` does only trivial local filtering over the entries it's given — no parsing, no mod-matching.
- **Message protocol** — host→webview: `init {entries, mod, file, state}` (reply to `ready`), `append {entries, cont, dropped}`, `reset {}`, `fileState {state, file}`, `mod {mod}`. webview→host: `ready`, `clear`, `openSettings` (runs `dcs.setup.open`).
