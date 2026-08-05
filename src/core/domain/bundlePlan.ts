import { payloadBase } from "./archivePolicy";
import { MANIFEST_FILE } from "./manifestFile";

// What ends up in the 7z — the ONE answer, shared by the packager that builds it
// and the form that previews it.
//
// This used to be four lines inside `PublishService.cutRelease` and nowhere
// else, which was fine while nothing else needed to know. The manifest form's
// archive preview (issue #72) needs exactly the same answer, and a preview with
// its own copy of "manifest first, then each path once" is a preview that drifts
// from what publish actually does — worse than no preview, because it is
// believed. So the rule moved here and `cutRelease` now calls it too: there is
// no second implementation to disagree with.

/** A `[[bundle]]` entry, as both the manifest model and the form hold one. */
export interface BundleEntry {
  path: string;
}

/**
 * The project-relative paths the payload archive holds, in the order the
 * packager adds them.
 *
 * Three rules, and all three are things the `[[bundle]]` section never said:
 *
 *  - **The manifest is always first**, declared or not. It is what makes the
 *    release readable without downloading the payload.
 *  - **One entry per path.** Declaring the same path twice packs it once — the
 *    match is a literal string comparison, so `Scripts` and `./Scripts` are two
 *    paths as far as this is concerned, exactly as they are to the packager.
 *  - **A blank path is not an entry.** The form appends `{ path: "" }` when you
 *    click Add bundled path, and `issues()` already flags it as an error. It
 *    reaches here as an unfilled row, never as an instruction — which matters
 *    because `join(root, "")` is the project root, so packing it would sweep the
 *    entire working tree, `.git` included, into a public release.
 *
 * Paths are returned verbatim: the archive stores each at its project-relative
 * path, which is what a `[[symlink]] source` later resolves against.
 */
export function archiveFiles(bundle: readonly BundleEntry[]): string[] {
  const seen = new Set<string>([MANIFEST_FILE]);
  const files = [MANIFEST_FILE];
  for (const entry of bundle) {
    const path = entry.path.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    files.push(path);
  }
  return files;
}

/**
 * The payload archive's file name as the MANIFEST FORM can know it.
 *
 * A guess, and labelled as one on screen. Publish names the archive after the
 * GitHub repo and the tag the release form is given (`payloadBase`), and GitHub
 * rewrites repo names it will not take verbatim — a scaffolded "My Mod" lands as
 * "My-Mod". The manifest's own name and version are what the publish form seeds
 * those two boxes with, so this is right whenever the author leaves them alone,
 * and the shape is right always.
 *
 * The placeholders keep an unfilled form from rendering `dcs-studio--.7z`, which
 * reads as a bug in the packager rather than as two boxes nobody has typed in.
 */
export function previewArchiveName(name: string, version: string): string {
  return `${payloadBase(name.trim() || "your-mod", version.trim() || "0.1.0")}.7z`;
}
