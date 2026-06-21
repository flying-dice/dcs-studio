// Pure helpers for the workspace fs-watcher reconciliation (issue #40),
// extracted from state.svelte.ts so they carry no runes and are unit-testable.

/** What an on-disk change means for an open buffer. */
export type ReconcileAction =
  | "noop" // disk matches the saved baseline (our own save, or a revert)
  | "reload" // clean buffer, disk changed → reload it silently
  | "stale"; // dirty buffer, disk changed → flag stale, never clobber edits

/** Decide how to reconcile one open buffer with its on-disk content. The order
 * matters: a change that already matches `savedText` is a no-op FIRST (so the
 * editor's own save can't trigger a reload), then clean vs dirty. */
export function reconcileBuffer(
  savedText: string,
  docText: string,
  onDiskText: string,
): ReconcileAction {
  if (onDiskText === savedText) return "noop";
  if (docText === savedText) return "reload";
  return "stale";
}

/** A comparison key robust to the separator / verbatim-prefix / drive-case
 * divergences between the fs watcher's emitted paths and the file tree's
 * identities (issue #40): strip a Windows `\\?\` prefix, unify separators, and
 * upper-case a leading drive letter (Windows is case-insensitive there). So a
 * change can never silently miss its open buffer over a cosmetic path mismatch. */
export function fsKey(path: string): string {
  let p = path.replace(/^\\\\\?\\/, ""); // strip \\?\ verbatim prefix
  p = p.replace(/\\/g, "/"); // unify separators
  return p.replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`);
}
