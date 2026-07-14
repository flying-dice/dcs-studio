import * as fs from "fs";
import * as path from "path";
import type * as vscode from "vscode";
import { manifestCore } from "../adapters/vscode/manifest";
import type { PublishService } from "../core/app/publishService";
import { type Check, computePreflight, type SourceProbe } from "../core/domain/publishChecks";
import type { ManifestModel } from "../core/domain/types";

// Preflight checks before publishing: is the manifest valid, do the [[bundle]]
// paths exist (built), and are the tools (7z, git) present. Errors block a
// release; warnings are advisory. This is adapter code for the Publish panel: it
// gathers the fs facts (manifest parse, per-source probes) and reads tool
// availability (7z, git, gh) through the injected PublishService, then delegates
// the pass/warn/fail policy to core/domain/publishChecks.ts.
export type { Check };

export function readManifest(ctx: vscode.ExtensionContext, root: string): ManifestModel | null {
  const p = path.join(root, "dcs-studio.toml");
  try {
    return manifestCore(ctx).parseToml(fs.readFileSync(p, "utf8"));
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
  ctx: vscode.ExtensionContext,
  root: string,
  publish: PublishService,
): Promise<Check[]> {
  const manifestExists = fs.existsSync(path.join(root, "dcs-studio.toml"));
  const manifest = manifestExists ? readManifest(ctx, root) : null;
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
