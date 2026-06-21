// Pure helpers for the debug session — extracted from debug-session.svelte.ts
// so they carry no runes/singleton state and are unit-testable in plain Node.

/** The sim-side source id for a file: a "=name" chunkname so the debugged
 * chunk's `debug.getinfo(...).source` reads back verbatim and lines up with the
 * breakpoints we register. */
export function sourceId(path: string): string {
  return `=${path}`;
}

/** The path embedded in a sim-side source id ("=path" → "path"). */
export function pathOf(source: string): string {
  return source.startsWith("=") ? source.slice(1) : source;
}

/** The file name (last path segment) of a path. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Render a Lua string literal, escaping the embedding hazards (so a path or
 * expression can't break out of the string and inject code). */
export function luaStr(s: string): string {
  const esc = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${esc}"`;
}

/** What a poll of `debug_state` means for the session, given whether the run has
 * EVER been observed active (paused or running) — `sawActive`. The "wait" case
 * is the guard that stops a transient "not running yet" at startup from ending
 * the session before it begins; "finish" is the running flag dropping AFTER
 * activity (the real end). Session-end is driven by this, NOT by the blocking
 * debug_run promise (which times out on a long run/pause). */
export function sessionAction(
  paused: boolean,
  running: boolean,
  sawActive: boolean,
): "pause" | "run" | "finish" | "wait" {
  if (paused) return "pause";
  if (running) return "run";
  if (sawActive) return "finish";
  return "wait";
}
