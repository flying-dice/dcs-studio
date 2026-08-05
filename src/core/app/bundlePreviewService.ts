import { win32 as path } from "node:path";
import { DEFAULT_VOLUME_BYTES, shouldSplit } from "../domain/archivePolicy";
import { archiveFiles, type BundleEntry, previewArchiveName } from "../domain/bundlePlan";
import { MANIFEST_FILE } from "../domain/manifestFile";
import type { FileSystemPort } from "../ports/filesystem";

// The archive the manifest form draws beside the `[[bundle]]` section (issue
// #72): what publish would pack from the entries as they stand right now,
// resolved against the real project on disk.
//
// The point of it is that the `[[bundle]]` section could describe none of this.
// One line of copy said paths get "packed into the release archive", and four
// things it never said are the ones people got wrong: the manifest rides along
// whether or not you declare it, a folder entry brings its whole tree, entries
// are stored at their project-relative paths rather than flattened, and a large
// payload is split into numbered volumes. Answering by SHOWING makes all four
// visible at once — and makes a path that has not been built yet visible before
// the publish preflight refuses it.
//
// Everything structural is taken from the packager's own functions rather than
// restated: `archiveFiles` for the list, `previewArchiveName` for the name,
// `shouldSplit` for the threshold. A preview with its own copy of those rules is
// one that drifts from what publish does, and is then believed anyway.

/** One row of the preview: a path in the archive, and what is actually there. */
export interface BundlePreviewRow {
  /** The project-relative path, exactly as the archive stores it. */
  path: string;
  /**
   * Whether the packager adds this row on its own account. True for the
   * manifest and nothing else — it is the row no `[[bundle]]` entry produced,
   * and the whole reason the row is labelled rather than merely listed.
   */
  always: boolean;
  /** `missing` is a path with nothing at it — usually a build that has not run. */
  kind: "file" | "dir" | "missing";
  files: number;
  bytes: number;
}

/** The archive publish would build from the form's current entries. */
export interface BundlePreview {
  /** `dcs-studio-<name>-<tag>.7z`, derived as `previewArchiveName` explains. */
  archiveName: string;
  rows: BundlePreviewRow[];
  totalFiles: number;
  /** Total size of the SOURCE content — see `likelySplit` for why that matters. */
  totalBytes: number;
  /** How many rows have nothing at them. */
  missing: number;
  /** The per-volume limit `likelySplit` was measured against. */
  volumeBytes: number;
  /**
   * Whether the payload is likely to be split into numbered volumes.
   *
   * "Likely", and the hedge is the honest word rather than a soft one. The
   * threshold is a limit on the COMPRESSED archive, and all this side knows is
   * the uncompressed source. The two directions are not symmetric: under the
   * limit here means under it after compression too, so a quiet preview is a
   * reliable "no split"; over it here means the archive may or may not clear the
   * limit once 7-Zip has been at it, so a flagged preview is a warning and not a
   * promise. Claiming certainty in the second case is the only way to be wrong.
   */
  likelySplit: boolean;
}

/** What the form asks about: its current entries, and the two [project] fields
 *  the archive name is derived from. */
export interface BundlePreviewRequest {
  bundle: readonly BundleEntry[];
  name: string;
  version: string;
}

export class BundlePreviewService {
  /**
   * Narrowed to the one method it uses, rather than the whole port. The preview
   * is READ-ONLY by construction that way: a future edit that reached for
   * `remove` or `writeText` would not compile, which matters for a service
   * whose inputs are paths the webview supplied.
   */
  constructor(private readonly fs: Pick<FileSystemPort, "measure">) {}

  /**
   * Measure `req`'s entries against the project at `root`.
   *
   * Rows come back in the packager's order, one per path, with the manifest
   * first — so what the form draws is the archive's own table of contents and
   * not a re-sorted list of the boxes above it.
   */
  async preview(root: string, req: BundlePreviewRequest): Promise<BundlePreview> {
    const files = archiveFiles(req.bundle);
    const rows: BundlePreviewRow[] = [];
    for (const rel of files) {
      const measured = await this.fs.measure(path.join(root, rel));
      rows.push({
        path: rel,
        always: rel === MANIFEST_FILE,
        kind: measured === null ? "missing" : measured.directory ? "dir" : "file",
        files: measured?.files ?? 0,
        bytes: measured?.bytes ?? 0,
      });
    }
    const totalBytes = rows.reduce((n, r) => n + r.bytes, 0);
    return {
      archiveName: previewArchiveName(req.name, req.version),
      rows,
      totalFiles: rows.reduce((n, r) => n + r.files, 0),
      totalBytes,
      missing: rows.filter((r) => r.kind === "missing").length,
      volumeBytes: DEFAULT_VOLUME_BYTES,
      likelySplit: shouldSplit(totalBytes),
    };
  }
}
