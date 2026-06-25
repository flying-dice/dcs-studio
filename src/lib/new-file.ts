// File → New File (⌘N) names new files. The app has no untitled-buffer concept
// — every editor tab is a real path on disk — so a menu "New File" must
// materialise a real, uniquely-named file under the project root; the developer
// renames it in the tree afterwards. This module owns only the name choice
// (pure + unit-tested); the fs create + open lives in tree-actions.ts
// (`newRootFile`), and `create_file` (Rust) refuses an existing target, so the
// name must not collide with a sibling.

/** Base name + extension for a new untitled file. DCS Studio is a DCS-Lua
 *  authoring IDE, so a new file defaults to Lua — its syntax mode and language
 *  intelligence light up immediately; rename in the tree for anything else. */
const BASE = "untitled";
const EXT = ".lua";

/**
 * The first of `<base>.lua`, `<base>-2.lua`, `<base>-3.lua`, … whose name is not
 * already in `taken` (the sibling names at the target directory). The comparison
 * folds case: Windows and macOS filesystems are case-insensitive, so an
 * `UNTITLED.LUA` on disk still collides with `untitled.lua`. The base is the
 * `untitled` default (`nextUntitledName`) or a recipe-derived slug (issue #60).
 */
export function uniqueLuaName(base: string, taken: Set<string>): string {
  const lower = new Set([...taken].map((n) => n.toLowerCase()));
  let candidate = `${base}${EXT}`;
  for (let i = 2; lower.has(candidate.toLowerCase()); i++) {
    candidate = `${base}-${i}${EXT}`;
  }
  return candidate;
}

/** The first free `untitled.lua`, `untitled-2.lua`, … not already in `taken`. */
export function nextUntitledName(taken: Set<string>): string {
  return uniqueLuaName(BASE, taken);
}
