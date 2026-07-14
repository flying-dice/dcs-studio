// Pure archive-packaging policy — the decisions that surround the 7-Zip CLI but
// need no I/O: which release assets are payload volumes, how large a volume may
// be, whether a single archive must be split, which files form a volume family,
// and the payload archive's base name. Kept adapter-free so it is trivially
// testable and shared by both the install (unpack) and publish (pack) sides.

/** GitHub rejects a release asset over 2 GiB; clamp each volume to 2 GiB − 128 MiB. */
export const MAX_VOLUME_BYTES = 2 * 1024 * 1024 * 1024 - 128 * 1024 * 1024;

/** Default per-volume split size (1.5 GiB), matching dcs-studio's DEFAULT_VOLUME_SIZE. */
export const DEFAULT_VOLUME_BYTES = Math.round(1.5 * 1024 * 1024 * 1024);

/** A release payload volume: `<base>.7z` or a numbered `<base>.7z.NNN` split part. */
const PAYLOAD_VOLUME_RE = /\.7z(\.\d{3})?$/i;

/**
 * The payload volumes among a release's assets, ordered so the first entry is the
 * archive 7-Zip must be pointed at (`.7z` or `.7z.001`). Non-payload assets (e.g.
 * the standalone manifest) are dropped.
 */
export function selectPayloadVolumes<T extends { name: string }>(assets: readonly T[]): T[] {
  return assets
    .filter((a) => PAYLOAD_VOLUME_RE.test(a.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The effective per-volume byte limit — never above the GitHub-safe maximum. */
export function volumeLimit(volumeBytes: number = DEFAULT_VOLUME_BYTES): number {
  return Math.min(volumeBytes, MAX_VOLUME_BYTES);
}

/** Whether a single archive of `archiveBytes` must be repacked into volumes. */
export function shouldSplit(
  archiveBytes: number,
  volumeBytes: number = DEFAULT_VOLUME_BYTES,
): boolean {
  return archiveBytes > volumeLimit(volumeBytes);
}

/** Whether `fileName` belongs to `<base>`'s volume family (`.7z` or `.7z.NNN`). */
export function isVolumeFamilyMember(fileName: string, base: string): boolean {
  return fileName === `${base}.7z` || fileName.startsWith(`${base}.7z.`);
}

/** The ordered numbered split volumes for `base` among a directory's file names. */
export function selectSplitVolumes(fileNames: readonly string[], base: string): string[] {
  return fileNames.filter((f) => f.startsWith(`${base}.7z.`)).sort();
}

/** Slugify a repo/tag component for use in an archive base name. */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `dcs-studio-<repo>-<tag>` — the payload archive base name. */
export function payloadBase(repoName: string, tag: string): string {
  return `dcs-studio-${slug(repoName)}-${slug(tag)}`;
}
