import { win32 as path } from "node:path";
import * as fs from "fs";
import type { PublishService } from "../core/app/publishService";
import { MANIFEST_FILE } from "../core/domain/manifestFile";
import { type Check, computePreflight, type SourceProbe } from "../core/domain/publishChecks";
import type { ManifestModel } from "../core/domain/types";
import type { ManifestPort } from "../core/ports/manifest";

// Preflight checks before publishing: is the manifest valid, do the [[bundle]]
// paths exist (built), and are the tools (7z, git) present. Errors block a
// release; warnings are advisory. This is adapter code for the Publish panel: it
// gathers the fs facts (manifest parse, per-source probes) and reads tool
// availability (7z, git, gh) through the injected PublishService, then delegates
// the pass/warn/fail policy to core/domain/publishChecks.ts.
//
// The manifest arrives as `ManifestPort`, not as the extension context to build
// the concrete core from: a feature naming an adapter is the boundary violation
// #61 tracks, and the port is all this ever wanted — one `parseToml`.
export type { Check };

export function readManifest(manifest: ManifestPort, root: string): ManifestModel | null {
  const p = path.join(root, MANIFEST_FILE);
  try {
    return manifest.parseToml(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Probe each [[bundle]] path: does it exist, and is it a symlink. */
function probeBundle(root: string, m: ManifestModel | null): SourceProbe[] {
  return (m?.bundle ?? []).map((b) => {
    const abs = path.join(root, b.path);
    try {
      return { source: b.path, missing: false, symlink: fs.lstatSync(abs).isSymbolicLink() };
    } catch {
      return { source: b.path, missing: true, symlink: false };
    }
  });
}

export async function preflight(
  manifestPort: ManifestPort,
  root: string,
  publish: PublishService,
): Promise<Check[]> {
  const manifestExists = fs.existsSync(path.join(root, MANIFEST_FILE));
  const manifest = manifestExists ? readManifest(manifestPort, root) : null;
  const tools = await publish.toolFacts();
  return computePreflight({
    manifestExists,
    manifest,
    bundle: probeBundle(root, manifest),
    sevenZip: tools.sevenZip,
    gitAvailable: tools.gitAvailable,
    gh: tools.gh,
  });
}
