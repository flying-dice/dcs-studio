// Path identity (model/studio/core.pds `CanonicalPath`).
//
// A filesystem path reaches the buffer and diagnostic layers from two
// sources that disagree on Windows: the OS file tree (`readDir`, the folder
// picker) yields an upper-case drive letter — `C:\Users\…\lib.rs` — while a
// language server's `file://` URI round-trips through `uriToPath` to a
// LOWER-case one — `c:\Users\…\lib.rs` (rust-analyzer lower-cases drive
// letters in the URIs it publishes). Without a single canonical form the
// same file opens twice (a file-tree tab and a Problems-click tab), and the
// tree tab's diagnostics — keyed by the server's lower-case path — never
// match, so its squiggles never paint.
//
// The canonical form upper-cases a leading drive letter and leaves a POSIX
// path (no drive) untouched; both sources already emit backslash separators
// on Windows, so only the drive case diverges. The result is still a valid
// OS path, so it is safe to read, write, and save through.

/** Reduce a path to one identity regardless of source (model `CanonicalPath`). */
export function canonicalPath(path: string): string {
  if (/^[a-z]:/.test(path)) return path[0].toUpperCase() + path.slice(1);
  return path;
}
