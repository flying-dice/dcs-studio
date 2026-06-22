// Pure helpers for bookmarks (model/studio/bookmarks.pds) — extracted from
// bookmarks.svelte.ts and editor/bookmark-gutter.ts so the re-map, the store
// splices, and the persistence parse carry no runes, no singleton, and no
// localStorage, and unit-test in plain Node. The store is the stateful shell
// over these transforms; the gutter re-maps marks through them. Same split as
// debug-util.ts ← debug-session.svelte.ts.

import type { ChangeDesc, Text } from "@codemirror/state";

/** One bookmark: a file, its 1-based line, and a snippet of that line's text
 *  (re-derived on save while open; the last-saved text once closed) — the
 *  panel's row label. */
export interface Bookmark {
  path: string;
  line: number;
  snippet: string;
}

/** Longest snippet kept — a marked minified line must not bloat the bucket. */
const SNIPPET_MAX = 200;

/** The stored/displayed snippet for a line: trimmed, capped. */
export function snippetOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > SNIPPET_MAX ? trimmed.slice(0, SNIPPET_MAX) : trimmed;
}

/** Published order: by path, then by line. */
export function byPathThenLine(a: Bookmark, b: Bookmark): number {
  return a.path.localeCompare(b.path) || a.line - b.line;
}

/** Drop out-of-range lines, dedupe, sort — the bookmark field's invariant. */
export function normalizeBookmarkLines(
  lines: number[],
  docLines: number,
): number[] {
  const kept = new Set<number>();
  for (const ln of lines) if (ln >= 1 && ln <= docLines) kept.add(ln);
  return [...kept].sort((a, b) => a - b);
}

/** Re-map marked lines through a document change — the edit-tolerant anchoring
 *  core. Map each marked line's start position through the change set with
 *  assoc +1 (so the mark binds to the code that FOLLOWS), resolve back to a line
 *  number, then normalize: a line inserted above a mark rides it down with its
 *  code, a deletion above rides it up, and deleting the marked line itself lands
 *  on the following code. `startDoc`/`endDoc` are the pre-/post-change docs. */
export function remapBookmarkLines(
  lines: number[],
  changes: ChangeDesc,
  startDoc: Text,
  endDoc: Text,
): number[] {
  const mapped: number[] = [];
  for (const ln of lines) {
    if (ln < 1 || ln > startDoc.lines) continue;
    const pos = changes.mapPos(startDoc.line(ln).from, 1);
    mapped.push(endDoc.lineAt(pos).number);
  }
  return normalizeBookmarkLines(mapped, endDoc.lines);
}

/** Toggle the mark on `path:line` (model `ToggleBookmark`): add carrying
 *  `snippet`, or remove if already marked. Returns a new set in published
 *  order. */
export function toggleBookmark(
  entries: Bookmark[],
  path: string,
  line: number,
  snippet: string,
): Bookmark[] {
  const has = entries.some((b) => b.path === path && b.line === line);
  return has
    ? entries.filter((b) => !(b.path === path && b.line === line))
    : [...entries, { path, line, snippet }].sort(byPathThenLine);
}

/** Remove a single mark (model `RemoveBookmark`); a no-op if absent. */
export function removeBookmark(
  entries: Bookmark[],
  path: string,
  line: number,
): Bookmark[] {
  return entries.filter((b) => !(b.path === path && b.line === line));
}

/** Re-anchor one file's marks after a save (model `RemapFileBookmarks`): SPLICE
 *  — drop only `path`'s old marks, insert the re-mapped ones, leave every other
 *  file's marks untouched. Returns a new set in published order. */
export function syncFileBookmarks(
  entries: Bookmark[],
  path: string,
  marks: { line: number; snippet: string }[],
): Bookmark[] {
  const kept = entries.filter((b) => b.path !== path);
  const fresh = marks.map((m) => ({ path, line: m.line, snippet: m.snippet }));
  return [...kept, ...fresh].sort(byPathThenLine);
}

/** All bookmarked lines for `path` — the editor gutter's marks. */
export function linesForPath(entries: Bookmark[], path: string): number[] {
  return entries.filter((b) => b.path === path).map((b) => b.line);
}

/** Parse a project's persisted bucket — the raw localStorage string, or null
 *  for an absent bucket — into marks (model `ReadPersisted`). An absent,
 *  corrupt, or non-array bucket restores nothing. An entry whose line is not a
 *  positive integer is dropped: a corrupt `line ≤ 0` would clear the type
 *  filter and paint a phantom panel row (the gutter normalizes it out, the
 *  panel does not), so it is rejected at parse. Never throws. */
export function parsePersisted(raw: string | null): Bookmark[] {
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (b): b is Bookmark =>
          typeof b?.path === "string" &&
          typeof b?.line === "number" &&
          Number.isInteger(b.line) &&
          b.line >= 1 &&
          typeof b?.snippet === "string",
      )
      .sort(byPathThenLine);
  } catch {
    return [];
  }
}
