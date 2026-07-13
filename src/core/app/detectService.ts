import * as path from "node:path";
import type { RegistryPort } from "../ports/registry";
import type { FileSystemPort } from "../ports/filesystem";
import type { EnvPort } from "../ports/env";
import {
  type DcsCandidate,
  REGISTRY_INSTALL_KEYS,
  compareInstallNames,
  compareSavedNames,
  installDetail,
  isDcsSavedName,
  programFilesInstallRoots,
  savedGameDetail,
} from "../domain/dcsDetect";

// Use-case service for DCS path detection. Composes the RegistryPort, FileSystemPort
// and EnvPort probes around the pure rules in core/domain/dcsDetect; the ordering,
// dedup and validity semantics match dcs-studio exactly.
export interface DetectDeps {
  registry: RegistryPort;
  fs: FileSystemPort;
  env: EnvPort;
}

export class DetectService {
  constructor(private readonly deps: DetectDeps) {}

  /** DCS Saved Games write dirs, plain `DCS` first then variants alphabetically. */
  async detectSavedGames(): Promise<DcsCandidate[]> {
    const home = this.deps.env.userProfile() || this.deps.env.homedir();
    const saved = path.join(home, "Saved Games");
    let entries: string[];
    try {
      entries = await this.deps.fs.readDir(saved);
    } catch {
      return [];
    }
    const out: DcsCandidate[] = [];
    for (const name of entries) {
      if (!isDcsSavedName(name)) continue;
      const p = path.join(saved, name);
      if (!(await this.deps.fs.isDirectory(p))) continue;
      const hasConfig = await this.deps.fs.isDirectory(path.join(p, "Config"));
      out.push({ path: p, name, ...savedGameDetail(hasConfig) });
    }
    out.sort((a, b) => compareSavedNames(a.name, b.name));
    return out;
  }

  /** DCS game installs from the registry then Program Files probes; deduped. */
  async detectGameInstalls(): Promise<DcsCandidate[]> {
    const found = new Map<string, DcsCandidate>();
    const add = async (root: string, name: string): Promise<void> => {
      if (!root) return;
      const key = root.toLowerCase();
      if (found.has(key) || !(await this.deps.fs.isDirectory(root))) return;
      const hasExe = await this.deps.fs.exists(path.join(root, "bin", "DCS.exe"));
      found.set(key, { path: root, name, ...installDetail(hasExe) });
    };

    for (const [hive, sub] of REGISTRY_INSTALL_KEYS) {
      for (const [name, root] of await this.deps.registry.queryValues(hive, sub, "Path")) {
        await add(root, name);
      }
    }
    for (const { name, root } of programFilesInstallRoots()) {
      await add(root, name);
    }
    return [...found.values()].sort((a, b) => compareInstallNames(a.name, b.name));
  }
}
