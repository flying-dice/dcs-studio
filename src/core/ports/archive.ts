import type { PackagedPayload } from "../domain/types";

// Port: archive packing/unpacking (7-Zip CLI adapter today). The pure decisions
// around it (volume sizing, family matching, base naming) live in
// `core/domain/archivePolicy.ts`; this port is only the I/O surface.

export interface ArchivePort {
  /** The resolved archiver command/path, or null when none is available. */
  available(): Promise<string | null>;
  /**
   * Extract an archive family into `outDir`. `archive` is the first/only volume
   * (`.7z` or `.7z.001`); the archiver picks up sibling volumes itself.
   */
  extract(archive: string, outDir: string): Promise<void>;
  /**
   * Package `files` (relative to `root`) into `<outDir>/<base>.7z`, splitting into
   * GitHub-safe volumes when the single archive exceeds `volumeBytes`.
   */
  packagePayload(
    root: string,
    files: string[],
    outDir: string,
    base: string,
    volumeBytes?: number,
  ): Promise<PackagedPayload>;
}
