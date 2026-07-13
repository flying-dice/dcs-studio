// Pure MissionScripting.lua sanitize/desanitize logic — ported from dcs-studio's
// mission manager, with all parsing and EOL-preserving edit computation operating
// on file CONTENT strings (no I/O). DCS ships MissionScripting.lua with a lockdown
// block:
//   do
//     sanitizeModule('os'); sanitizeModule('io'); sanitizeModule('lfs')
//     _G['require'] = nil; _G['loadlib'] = nil; _G['package'] = nil
//   end
// Desanitize = comment those lines out (so mission scripts — and the bridge — can
// use the full Lua environment); re-sanitize = uncomment. Quote style and
// whitespace are tolerated; indentation and the file's EOL are preserved. The
// backup-decision rule (snapshot a pristine copy on the first change) and the file
// I/O live in the app service, not here.

export const ITEMS = ["os", "io", "lfs", "require", "loadlib", "package"] as const;

/** The three items toggled via `sanitizeModule('<name>')`; the rest via `_G[...]`. */
function isModule(name: string): boolean {
  return name === "os" || name === "io" || name === "lfs";
}

/** Strip a leading `'<name>'` or `"<name>"`; returns the remainder or null. */
export function stripQuoted(s: string, name: string): string | null {
  for (const q of ["'", '"']) {
    if (s.startsWith(q)) {
      const rest = s.slice(1);
      if (rest.startsWith(name) && rest.slice(name.length).startsWith(q)) {
        return rest.slice(name.length + 1);
      }
      return null;
    }
  }
  return null;
}

/** Does `code` (indent + any `--` already stripped) match `name`'s statement? */
export function codeMatches(code: string, name: string): boolean {
  code = code.trim();
  if (isModule(name)) {
    if (!code.startsWith("sanitizeModule")) return false;
    let rest = code.slice("sanitizeModule".length).trimStart();
    if (!rest.startsWith("(")) return false;
    rest = rest.slice(1).trimStart();
    const q = stripQuoted(rest, name);
    if (q === null) return false;
    return q.trimStart().startsWith(")");
  }
  if (!code.startsWith("_G")) return false;
  let rest = code.slice(2).trimStart();
  if (!rest.startsWith("[")) return false;
  rest = rest.slice(1).trimStart();
  const q = stripQuoted(rest, name);
  if (q === null) return false;
  rest = q.trimStart();
  if (!rest.startsWith("]")) return false;
  rest = rest.slice(1).trimStart();
  if (!rest.startsWith("=")) return false;
  rest = rest.slice(1).trimStart();
  return rest.startsWith("nil");
}

/** null = no match; true = active (uncommented → sanitized); false = commented out. */
export function lineState(line: string, name: string): boolean | null {
  const body = line.trimStart();
  if (body.startsWith("--")) {
    let rest = body.slice(2);
    if (rest.startsWith(" ")) rest = rest.slice(1);
    return codeMatches(rest, name) ? false : null;
  }
  return codeMatches(body, name) ? true : null;
}

/** Toggle a line toward its desired state, preserving indentation; null if no
 *  requested item matches or it's already in the desired state. */
export function toggledLine(line: string, desired: Record<string, boolean>): string | null {
  let match: { want: boolean; active: boolean } | undefined;
  for (const name of Object.keys(desired)) {
    const st = lineState(line, name);
    if (st !== null) {
      match = { want: desired[name], active: st };
      break;
    }
  }
  if (!match || match.active === match.want) return null;
  const wsLen = line.length - line.trimStart().length;
  const indent = line.slice(0, wsLen);
  const body = line.slice(wsLen);
  if (match.want) {
    // Reaching here with want=true means the line was detected commented, so
    // `body` begins with the "-- " (or "--") that lineState matched.
    let rest = body.slice(2);
    if (rest.startsWith(" ")) rest = rest.slice(1);
    return indent + rest;
  }
  return indent + "-- " + body;
}

/** `<path>.dcsstudio.bak` — the pristine-snapshot backup path for a live file. */
export function backupPath(p: string): string {
  return p + ".dcsstudio.bak";
}

export interface MissionItemState {
  name: string;
  present: boolean;
  sanitized: boolean;
}

export interface MissionStatus {
  path: string;
  exists: boolean;
  backupExists: boolean;
  items: MissionItemState[];
}

/** Per-item presence/sanitized state derived purely from file content. */
export function scanItems(content: string): MissionItemState[] {
  const lines = content.split("\n");
  return ITEMS.map((name) => {
    let present = false;
    let sanitized = false;
    for (const line of lines) {
      const st = lineState(line, name);
      if (st !== null) {
        present = true;
        if (st) sanitized = true;
      }
    }
    return { name, present, sanitized };
  });
}

/** The result of computing a desired-state edit over file content. */
export interface SanitizeEdit {
  /** The rewritten content (with the file's original EOL preserved). */
  content: string;
  /** Whether any line was toggled — the caller writes/backs up only when true. */
  changed: boolean;
}

/** Apply the desired sanitized state to `content`, preserving its EOL. */
export function applyDesired(content: string, desired: Record<string, boolean>): SanitizeEdit {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const nl = toggledLine(lines[i], desired);
    if (nl !== null) {
      lines[i] = nl;
      changed = true;
    }
  }
  return { content: lines.join(eol), changed };
}

/** Desired map setting every item to `sanitized`. */
export function allItems(sanitized: boolean): Record<string, boolean> {
  const d: Record<string, boolean> = {};
  for (const n of ITEMS) d[n] = sanitized;
  return d;
}
