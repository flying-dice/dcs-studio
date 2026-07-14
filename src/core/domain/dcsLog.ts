// Pure domain logic for the DCS Log viewer (issue #4): parsing dcs.log lines,
// deciding whether a line belongs to "my" mod, and buffering parsed entries
// with a bounded cap. No I/O — the tailer (src/log/tailer.ts) reads bytes off
// disk and the panel (src/log/logPanel.ts) wires it all to a webview; this
// file only does string math so it can carry 100% branch coverage.
//
// dcs.log line shape (per DCS's own logger):
//   <yyyy-mm-dd hh:mm:ss.mmm> <LEVEL> <SUBSYSTEM> (<thread>): <message>
// e.g. `2026-07-13 12:00:00.001 INFO    my-mod (Main): hello`
// Some builds omit the thread parens; preamble lines (`=== Log opened UTC ...`)
// and multi-line continuations (stack traces, indented detail) don't match
// either shape and are treated as continuations of the previous entry.

import { slugify } from "./projectTemplates";

export type LogLevel = "INFO" | "WARNING" | "ERROR" | "DEBUG" | "ALERT";

const LEVELS = new Set<string>(["INFO", "WARNING", "ERROR", "DEBUG", "ALERT"]);

/** `^(date) (LEVEL) (subsystem) (thread): (message)$` — the common case. */
const WITH_THREAD =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(INFO|WARNING|ERROR|DEBUG|ALERT)\s+(\S+)\s*\(([^)]*)\):\s?(.*)$/;

/** Thread-less fallback some builds emit: `(date) (LEVEL) (subsystem): (message)`. */
const NO_THREAD =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(INFO|WARNING|ERROR|DEBUG|ALERT)\s+(\S+):\s?(.*)$/;

/** A successfully parsed `dcs.log` entry line. */
export interface ParsedLogEntry {
  kind: "entry";
  time: string;
  level: LogLevel;
  subsystem: string;
  /** Thread name, or `null` for the thread-less line shape. */
  thread: string | null;
  message: string;
}

/** Anything that isn't a recognised entry line: preamble, stack trace, etc. */
export interface ParsedContinuation {
  kind: "continuation";
  text: string;
}

export type ParsedLine = ParsedLogEntry | ParsedContinuation;

/** Parse one raw (already line-split, `\r`-stripped) `dcs.log` line. */
export function parseDcsLogLine(raw: string): ParsedLine {
  const withThread = WITH_THREAD.exec(raw);
  if (withThread) {
    const [, time, level, subsystem, thread, message] = withThread;
    return { kind: "entry", time, level: level as LogLevel, subsystem, thread, message };
  }
  const noThread = NO_THREAD.exec(raw);
  if (noThread) {
    const [, time, level, subsystem, message] = noThread;
    return { kind: "entry", time, level: level as LogLevel, subsystem, thread: null, message };
  }
  return { kind: "continuation", text: raw };
}

/** `true` for the five levels dcs.log ever emits. */
export function isLogLevel(s: string): s is LogLevel {
  return LEVELS.has(s);
}

// ── Chunk -> lines ──────────────────────────────────────────────────────

/**
 * Buffers a stream of text chunks into complete lines. A chunk boundary can
 * land mid-line (never mid-`\n`, since the tailer decodes bytes to text
 * before this runs) — the trailing partial line is held until the next
 * `push()` or returned by `flush()` at EOF/reset. `\r` (CRLF) is stripped
 * from every emitted line.
 */
export class LineDecoder {
  private buf = "";

  /** Feed a text chunk; returns every complete line it produced (`\r` stripped). */
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split("\n");
    // split() on a string always yields at least one element, so pop() here
    // is never undefined — no need for a fallback that coverage can't reach.
    this.buf = parts.pop() as string;
    return parts.map(stripCR);
  }

  /** Flush a trailing partial line with no terminator yet (EOF/reset). */
  flush(): string | null {
    if (!this.buf) return null;
    const line = stripCR(this.buf);
    this.buf = "";
    return line;
  }
}

function stripCR(s: string): string {
  return s.endsWith("\r") ? s.slice(0, -1) : s;
}

// ── Current-mod identity ────────────────────────────────────────────────

/** The current project's log identity, derived from its manifest name. */
export interface ModIdentity {
  /** `slugify(project.name)` — matched against the log `SUBSYSTEM` (case-insensitively). */
  slug: string;
  /** `project.name` as-is — matched as a `[name]` tag inside the message. */
  name: string;
}

/** Derive the current mod's log identity from its manifest `project.name`, or `null` if unavailable. */
export function modIdentity(projectName: string | null | undefined): ModIdentity | null {
  const name = projectName?.trim();
  if (!name) return null;
  return { slug: slugify(name), name };
}

/**
 * Whether a parsed entry belongs to the current mod: its `SUBSYSTEM` equals
 * the slug (case-insensitive; lua-hook/rust-dll mods logging via
 * `log.write(slug, ...)`), or its message contains `[name]` (lua-mission
 * scripts logging via `env.info("[name] ...")`, subsystem `SCRIPTING`).
 */
export function matchesMod(
  entry: { subsystem: string | null; message: string },
  mod: ModIdentity | null,
): boolean {
  if (!mod) return false;
  if (entry.subsystem && entry.subsystem.toLowerCase() === mod.slug.toLowerCase()) return true;
  return entry.message.includes(`[${mod.name}]`);
}

// ── Bounded buffer ──────────────────────────────────────────────────────

/** One buffered log entry (a parsed line plus any continuation lines attached under it). */
export interface LogEntry {
  /** Monotonic, never reused even across `clear()` — a stable React-style key. */
  seq: number;
  time: string | null;
  level: LogLevel | null;
  subsystem: string | null;
  thread: string | null;
  message: string;
  /** Whether this entry matches the current mod identity. */
  mine: boolean;
  /** Continuation lines (stack traces, wrapped detail) attached under this entry. */
  cont: string[];
}

/** Outcome of `LogBuffer.push()`: a fresh entry, or a continuation attached to an existing one. */
export type LogBufferEvent =
  | { kind: "added"; entry: LogEntry }
  | { kind: "continued"; entry: LogEntry };

const DEFAULT_CAP = 5000;

/**
 * A capped ring of parsed log entries. Continuation lines attach to the
 * most recent entry's `cont[]` rather than becoming entries of their own —
 * unless the buffer is empty (nothing to attach to), in which case the
 * continuation is promoted to a standalone entry so no output is silently
 * lost. Pushing past the cap evicts the oldest entry and increments
 * `droppedCount`.
 */
export class LogBuffer {
  private readonly entries: LogEntry[] = [];
  private seq = 0;
  private dropped = 0;

  constructor(private readonly cap: number = DEFAULT_CAP) {}

  /** Current buffered entries, oldest first. */
  list(): readonly LogEntry[] {
    return this.entries;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Cumulative count of entries evicted for exceeding the cap. */
  get droppedCount(): number {
    return this.dropped;
  }

  /** Parse and buffer one raw line, stamping `mine` against the given mod identity. */
  push(raw: string, mod: ModIdentity | null): LogBufferEvent {
    const parsed = parseDcsLogLine(raw);
    if (parsed.kind === "continuation") {
      const last = this.entries[this.entries.length - 1];
      if (last) {
        last.cont.push(parsed.text);
        return { kind: "continued", entry: last };
      }
      return { kind: "added", entry: this.add(null, null, null, null, parsed.text, mod) };
    }
    return {
      kind: "added",
      entry: this.add(
        parsed.time,
        parsed.level,
        parsed.subsystem,
        parsed.thread,
        parsed.message,
        mod,
      ),
    };
  }

  /** Drop every buffered entry and reset the dropped counter (seq stays monotonic). */
  clear(): void {
    this.entries.length = 0;
    this.dropped = 0;
  }

  private add(
    time: string | null,
    level: LogLevel | null,
    subsystem: string | null,
    thread: string | null,
    message: string,
    mod: ModIdentity | null,
  ): LogEntry {
    const entry: LogEntry = {
      seq: ++this.seq,
      time,
      level,
      subsystem,
      thread,
      message,
      mine: matchesMod({ subsystem, message }, mod),
      cont: [],
    };
    this.entries.push(entry);
    if (this.entries.length > this.cap) {
      this.entries.shift();
      this.dropped++;
    }
    return entry;
  }
}
