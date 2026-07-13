import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { find7z } from "../adapters/node/sevenZip";
import { hasGitSync } from "../adapters/node/git";
import { ghFactsSync } from "../adapters/node/gh";
import { manifestCore } from "../adapters/vscode/manifestPort";
import { computePreflight, type Check, type SourceProbe } from "../core/domain/publishChecks";
import type { ManifestModel } from "../core/domain/types";

// Preflight checks before publishing: is the manifest valid, do the install
// sources exist (built), and are the tools (7z, git) present. Errors block a
// release; warnings are advisory. This is adapter code for the Publish panel: it
// gathers the facts (fs probes, tool availability) and delegates the pass/warn/
// fail policy to core/domain/publishChecks.ts. No core service is wired here.
export type { Check };

export function readManifest(ctx: vscode.ExtensionContext, root: string): ManifestModel | null {
  const p = path.join(root, "dcs-studio.toml");
  try {
    return manifestCore(ctx).parseToml(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Probe each [[install]] source: does it exist, and is it a symlink. */
function probeSources(root: string, m: ManifestModel | null): SourceProbe[] {
  return (m?.install ?? []).map((r) => {
    const abs = path.join(root, r.source);
    try {
      return { source: r.source, missing: false, symlink: fs.lstatSync(abs).isSymbolicLink() };
    } catch {
      return { source: r.source, missing: true, symlink: false };
    }
  });
}

export function preflight(ctx: vscode.ExtensionContext, root: string): Check[] {
  const manifestExists = fs.existsSync(path.join(root, "dcs-studio.toml"));
  const manifest = manifestExists ? readManifest(ctx, root) : null;
  return computePreflight({
    manifestExists,
    manifest,
    sources: probeSources(root, manifest),
    sevenZip: find7z(),
    gitAvailable: hasGitSync(),
    gh: ghFactsSync(),
  });
}
