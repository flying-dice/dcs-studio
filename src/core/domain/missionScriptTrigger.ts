// Pure trigger-line machinery for the managed MissionScripting.lua entrypoint.
// DCS Studio owns two `dofile(...)` lines in `<gameInstall>/Scripts/
// MissionScripting.lua`: one BEFORE the sanitize lockdown block (so its target
// runs with the full, unsanitized Lua environment) and one AFTER it (so its
// target runs in the normal sandboxed mission env). This module detects the
// trigger status per line, inserts them idempotently in the correct positions,
// and removes them — all as pure functions over the file CONTENT string, EOL-
// and indent-preserving, mirroring missionSanitize's editing discipline. The
// file I/O and backup-first rule live in the app service, not here.
//
// The sanitize block is located via the same per-item line detection that
// missionSanitize uses: the block spans from the first to the last line that
// matches one of the six lockdown statements (commented or not). This is robust
// to desanitized files — a commented `-- sanitizeModule('os')` still counts as a
// block line, so trigger positions stay correct whether or not the lockdown is
// currently active.

import { ITEMS, lineState } from "./missionSanitize";

/** The managed aggregator file names (in Saved Games/DCS/Scripts). */
export const BEFORE_SANITIZE_FILE = "DcsStudioMissionScriptsBeforeSanitize.lua";
export const AFTER_SANITIZE_FILE = "DcsStudioMissionScriptsAfterSanitize.lua";

/** The canonical trigger line for each aggregator (top-level, no indent). */
export const BEFORE_TRIGGER = `dofile(lfs.writedir()..'Scripts/${BEFORE_SANITIZE_FILE}')`;
export const AFTER_TRIGGER = `dofile(lfs.writedir()..'Scripts/${AFTER_SANITIZE_FILE}')`;

/** valid = present in the right place; missing = absent; wrong-position = present
 *  but on the wrong side of the sanitize block. */
export type TriggerStatus = "valid" | "missing" | "wrong-position";

export interface TriggerStatuses {
  before: TriggerStatus;
  after: TriggerStatus;
}

/** The result of computing a trigger edit over file content. */
export interface TriggerEdit {
  /** The rewritten content (with the file's original EOL preserved). */
  content: string;
  /** Whether the content changed — the caller writes/backs up only when true. */
  changed: boolean;
}

/** True if a line is DCS Studio's before-sanitize trigger (tolerant of spacing
 *  and quote style — matches any `dofile(...)` naming the aggregator file). */
export function isBeforeTrigger(line: string): boolean {
  return isTriggerFor(line, BEFORE_SANITIZE_FILE);
}

/** True if a line is DCS Studio's after-sanitize trigger. */
export function isAfterTrigger(line: string): boolean {
  return isTriggerFor(line, AFTER_SANITIZE_FILE);
}

function isTriggerFor(line: string, file: string): boolean {
  const t = line.trim();
  if (!t.startsWith("dofile")) return false;
  return t.includes(file);
}

/**
 * The [first, last] line indices spanning the sanitize block, or null if the
 * file contains none of the lockdown statements. The span is the lockdown
 * statement lines, expanded to the enclosing `do`/`end` wrapper when present so
 * the triggers wrap the whole block (before `do`, after `end`) — matching how
 * DCS ships the file. Expansion crosses only blank/comment lines; a real
 * statement between the wrapper and the lockdown lines stops it.
 */
function sanitizeBounds(lines: string[]): { first: number; last: number } | null {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    const isBlockLine = ITEMS.some((name) => lineState(lines[i], name) !== null);
    if (isBlockLine) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) return null;
  return { first: expandToOpener(lines, first), last: expandToCloser(lines, last) };
}

function isSkippable(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("--");
}

/** Walk up from the first lockdown line to a `do` opener, past blank/comments. */
function expandToOpener(lines: string[], first: number): number {
  for (let i = first - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t === "do") return i;
    if (!isSkippable(lines[i])) break;
  }
  return first;
}

/** Walk down from the last lockdown line to an `end` closer, past blank/comments. */
function expandToCloser(lines: string[], last: number): number {
  for (let i = last + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "end") return i;
    if (!isSkippable(lines[i])) break;
  }
  return last;
}

/** Split content into logical lines (stripping any trailing \r) plus its EOL. */
function splitLines(content: string): { lines: string[]; eol: string } {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  return { lines, eol };
}

/** Per-line trigger status derived purely from file content. */
export function triggerStatus(content: string): TriggerStatuses {
  const { lines } = splitLines(content);
  const bounds = sanitizeBounds(lines);
  const beforeIdx = lines.findIndex(isBeforeTrigger);
  const afterIdx = lines.findIndex(isAfterTrigger);
  return {
    before: statusFor(beforeIdx, "before", bounds),
    after: statusFor(afterIdx, "after", bounds),
  };
}

function statusFor(
  idx: number,
  side: "before" | "after",
  bounds: { first: number; last: number } | null,
): TriggerStatus {
  if (idx === -1) return "missing";
  // With no sanitize block, position cannot be judged — a present line is valid.
  if (!bounds) return "valid";
  if (side === "before") return idx < bounds.first ? "valid" : "wrong-position";
  return idx > bounds.last ? "valid" : "wrong-position";
}

/**
 * Idempotently install both trigger lines in the correct positions. Any existing
 * trigger lines (in any position) are first removed, then the before-line is
 * inserted immediately above the sanitize block and the after-line immediately
 * below it — so re-running is a no-op on an already-correct file and a self-fix
 * on a wrong-position one. When the file has no sanitize block, the before-line
 * is prepended and the after-line appended.
 */
export function installTriggers(content: string): TriggerEdit {
  const { lines, eol } = splitLines(content);
  const cleaned = lines.filter((l) => !isBeforeTrigger(l) && !isAfterTrigger(l));
  const bounds = sanitizeBounds(cleaned);
  if (bounds) {
    // Insert the later position first so the earlier index is unaffected.
    cleaned.splice(bounds.last + 1, 0, AFTER_TRIGGER);
    cleaned.splice(bounds.first, 0, BEFORE_TRIGGER);
  } else {
    cleaned.unshift(BEFORE_TRIGGER);
    cleaned.push(AFTER_TRIGGER);
  }
  const rebuilt = cleaned.join(eol);
  return { content: rebuilt, changed: rebuilt !== content };
}

/** Remove both trigger lines wherever they appear, preserving the file's EOL. */
export function removeTriggers(content: string): TriggerEdit {
  const { lines, eol } = splitLines(content);
  const cleaned = lines.filter((l) => !isBeforeTrigger(l) && !isAfterTrigger(l));
  const rebuilt = cleaned.join(eol);
  return { content: rebuilt, changed: rebuilt !== content };
}
