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
```

## Design notes

- **Split**: `src/core/domain/dcsLog.ts` is pure — line parsing (`parseDcsLogLine`), chunk-to-line decoding (`LineDecoder`), mod-identity matching (`modIdentity`/`matchesMod`), and the bounded ring (`LogBuffer`) — with 100% per-file test coverage. `src/log/tailer.ts` (`LogTailer`) is the only place touching the filesystem: 500 ms `stat` polling, 256 KiB backfill, ≤1 MiB reads per tick, truncation-by-size-shrink detection (DCS restarts truncate; Windows gives no reliable rotation signal, so a rotate-then-regrow between ticks is undetectable — accepted). `src/log/logPanel.ts` (`LogPanel`) wires the tailer to a `ConsolePanel`-shaped singleton webview and resolves "my mod" from the workspace manifest. `media/log.js` does only trivial local filtering over the entries it's given — no parsing, no mod-matching.
- **Message protocol** — host→webview: `init {entries, mod, file, state}` (reply to `ready`), `append {entries, cont, dropped}`, `reset {}`, `fileState {state, file}`, `mod {mod}`. webview→host: `ready`, `clear`, `openSettings` (runs `dcs.setup.open`).
