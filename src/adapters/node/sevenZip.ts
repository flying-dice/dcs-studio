import * as fs from "fs";
import * as path from "path";
import { spawn, spawnSync } from "child_process";
import type { ArchivePort } from "../../core/ports/archive";
import type { PackagedPayload } from "../../core/domain/types";
import {
  DEFAULT_VOLUME_BYTES,
  MAX_VOLUME_BYTES,
  isVolumeFamilyMember,
  payloadBase,
  selectSplitVolumes,
  shouldSplit,
  volumeLimit,
} from "../../core/domain/archivePolicy";

// Node adapter for the 7-Zip CLI, implementing `ArchivePort`. It owns every 7z
// process spawn (find/extract/pack) and the on-disk volume housekeeping; the pure
// sizing/naming decisions live in core/domain/archivePolicy.ts. The publish and
// install services reach the CLI through this adapter (find7z is also used by the
// setup/preflight panels), so the 7z surface stays in one place.

/** The archive volume file(s): one `<base>.7z`, or ordered `<base>.7z.NNN`. */
export type Packaged = PackagedPayload;

// Re-export the frozen sizing constants for shim consumers.
export { MAX_VOLUME_BYTES, DEFAULT_VOLUME_BYTES, payloadBase };

const CANDIDATES = [
  "7z",
  "7za",
  "C:\\Program Files\\7-Zip\\7z.exe",
  "C:\\Program Files (x86)\\7-Zip\\7z.exe",
];

/** The user-configured 7z path (dcsStudio.sevenZipPath), if set. Lazy-requires
 *  vscode so this module stays usable in plain-node tests. */
function configuredPath(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require("vscode");
    return vscode.workspace.getConfiguration("dcsStudio").get("sevenZipPath")?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Whether a 7z candidate is usable: an absolute/path form must exist on disk; a
 *  bare command must run. */
function usable(c: string): boolean {
  if (/[\\/]/.test(c)) return fs.existsSync(c);
  try {
    return !spawnSync(c, [], { windowsHide: true }).error;
  } catch {
    return false;
  }
}

/** Resolve a usable 7-Zip command, or null. The configured path wins. */
export function find7z(): string | null {
  const configured = configuredPath();
  const candidates = configured ? [configured, ...CANDIDATES] : CANDIDATES;
  for (const c of candidates) {
    if (usable(c)) return c;
  }
  return null;
}

function run7z(cmd: string, cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, windowsHide: true });
    let err = "";
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.stdout.on("data", () => undefined);
    proc.on("error", (e) => reject(new Error(`7z failed to start: ${e.message}`)));
    proc.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`7z exited ${code}: ${err.trim() || "(no output)"}`)),
    );
  });
}

/** Extract an archive family (first volume) into `outDir`. */
function extract7z(cmd: string, archive: string, outDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, ["x", "-y", `-o${outDir}`, archive], { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", (e) => reject(new Error(`7z: ${e.message}`)));
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`7z extract exited ${c}: ${err.trim()}`))));
  });
}

/** Remove any prior `<base>.7z` and `<base>.7z.NNN` volumes in `outDir`. */
export function cleanVolumeFamily(outDir: string, base: string): void {
  if (!fs.existsSync(outDir)) return;
  for (const f of fs.readdirSync(outDir)) {
    if (isVolumeFamilyMember(f, base)) {
      fs.rmSync(path.join(outDir, f), { force: true });
    }
  }
}

/**
 * Package `files` (relative to `root`) into `<outDir>/<base>.7z`, splitting into
 * GitHub-safe volumes when the single archive exceeds `volumeBytes`.
 */
export async function packagePayload(
  cmd: string,
  root: string,
  files: string[],
  outDir: string,
  base: string,
  volumeBytes: number = DEFAULT_VOLUME_BYTES,
): Promise<Packaged> {
  fs.mkdirSync(outDir, { recursive: true });
  cleanVolumeFamily(outDir, base);
  const limit = volumeLimit(volumeBytes);
  const archive = path.join(outDir, `${base}.7z`);

  // First pass: a single archive (no -v, so small payloads stay one clean .7z).
  await run7z(cmd, root, ["a", "-t7z", "-mx=5", "-y", archive, ...files]);
  const size = fs.statSync(archive).size;
  if (!shouldSplit(size, volumeBytes)) return { volumes: [archive], totalBytes: size, split: false };

  // Too big for one asset: repack into numbered volumes.
  fs.rmSync(archive, { force: true });
  await run7z(cmd, root, ["a", "-t7z", "-mx=5", "-y", `-v${limit}b`, archive, ...files]);
  const volumes = selectSplitVolumes(fs.readdirSync(outDir), base).map((f) => path.join(outDir, f));
  const totalBytes = volumes.reduce((s, v) => s + fs.statSync(v).size, 0);
  return { volumes, totalBytes, split: true };
}

/** `ArchivePort` over the 7-Zip CLI. */
export class SevenZipArchive implements ArchivePort {
  async available(): Promise<string | null> {
    return find7z();
  }

  async extract(archive: string, outDir: string): Promise<void> {
    const cmd = find7z();
    if (!cmd) throw new Error("7-Zip not found — install 7-Zip (7-zip.org) to install mods.");
    await extract7z(cmd, archive, outDir);
  }

  async packagePayload(
    root: string,
    files: string[],
    outDir: string,
    base: string,
    volumeBytes: number = DEFAULT_VOLUME_BYTES,
  ): Promise<PackagedPayload> {
    const cmd = find7z();
    if (!cmd) throw new Error("7z not found.");
    return packagePayload(cmd, root, files, outDir, base, volumeBytes);
  }
}
