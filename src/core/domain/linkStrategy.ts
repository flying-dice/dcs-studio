// Pure link-strategy decision, extracted from the linker adapter. Given the
// probed facts about a link (platform, whether the target is a directory, whether
// link and target share a volume root), decide which OS primitive to use. The
// adapter performs the actual syscall and maps failures to messages; this module
// only decides, so the matrix is trivially testable.

import { parse } from "node:path";

/**
 * The link primitive to use:
 * - `symlink-dir` / `symlink-file` — non-Windows symlink (typed dir/file).
 * - `junction` — Windows directory link (no elevation needed).
 * - `hardlink` — Windows same-volume file link.
 * - `symlink-cross` — Windows cross-volume file: symlink, elevating on EPERM.
 */
export type LinkStrategy =
  | "symlink-dir"
  | "symlink-file"
  | "junction"
  | "hardlink"
  | "symlink-cross";

/** Facts probed from the filesystem that drive the strategy choice. */
export interface LinkFacts {
  isWindows: boolean;
  isDir: boolean;
  sameVolume: boolean;
}

/** Whether `link` and `target` sit on the same volume root (case-insensitive). */
export function sameVolume(link: string, target: string): boolean {
  return parse(link).root.toLowerCase() === parse(target).root.toLowerCase();
}

/** Choose the link primitive for the probed facts. */
export function chooseLinkStrategy(f: LinkFacts): LinkStrategy {
  if (!f.isWindows) return f.isDir ? "symlink-dir" : "symlink-file";
  if (f.isDir) return "junction";
  return f.sameVolume ? "hardlink" : "symlink-cross";
}

/** Facts probed about an already-existing link destination. */
export interface DestFacts {
  srcIsDir: boolean;
  destIsDir: boolean;
  /** lstat reports junctions/symlinks as symbolic links, never real dirs. */
  destIsSymlink: boolean;
}

/**
 * Whether an existing destination is merged into rather than a conflict: only a
 * real directory (not a junction/symlink) with a directory source — e.g. Saved
 * Games\Scripts\Hooks — is entered and each child linked individually, so shared
 * DCS folders never block an enable and a disable removes only our links.
 */
export function shouldMergeInto(f: DestFacts): boolean {
  return f.srcIsDir && f.destIsDir && !f.destIsSymlink;
}

/** Facts about an existing destination when deciding how to (re)link it. */
export interface ExistingDestFacts extends DestFacts {
  /**
   * The existing destination is a link/hard link that already points at our
   * source (junction/symlink resolves to it, or same inode) — i.e. a link left
   * by a previous enable, not a foreign file.
   */
  ownedByUs: boolean;
}

/**
 * How to treat an existing destination during an enable:
 * - `merge` — a real directory to enter and link children of individually.
 * - `enter` — a FILE source whose dest is an existing real directory: the rule
 *   means "link the file into that folder" (the lua-hook template's
 *   `dest = "{SavedGames}/Scripts/Hooks"` shape), so the link is created at
 *   `dest/<basename(source)>` — where adopt/conflict then apply per file.
 * - `adopt` — a link we already created for this source; a re-enable is
 *   idempotent, so accept and re-track it without touching the filesystem.
 * - `conflict` — a foreign file/dir (or a link pointing elsewhere); fail, naming
 *   the exact destination that clashed.
 */
export type DestDisposition = "merge" | "enter" | "adopt" | "conflict";

/** Decide how to treat an existing destination (see {@link DestDisposition}). */
export function classifyExistingDest(f: ExistingDestFacts): DestDisposition {
  if (shouldMergeInto(f)) return "merge";
  if (!f.srcIsDir && f.destIsDir && !f.destIsSymlink) return "enter";
  return f.ownedByUs ? "adopt" : "conflict";
}
