import * as path from "node:path";

// Pure DCS path-detection logic — ported from dcs-studio (dcs-studio-project::detect
// + studio-services::mission probes). Everything here is I/O-free: the `reg query`
// stdout parser, the Saved Games name filter + ordering, the Program Files probe
// roots, the validity/detail derivation, and the Setup-panel per-role validation
// rule. The app service (core/app/detectService) supplies the probe results.

export interface DcsCandidate {
  path: string;
  name: string;
  valid: boolean;
  detail: string;
}

/**
 * Parse `reg query "<hive>\<sub>" /s /v <valueName>` stdout into `[subkeyName, value]`
 * pairs. Lines beginning `HKEY_` set the current key; a `  <valueName>  REG_SZ  <value>`
 * line under a key yields the key's last path segment paired with the value.
 */
export function parseRegistryQuery(stdout: string, valueName: string): Array<[string, string]> {
  const valueRe = new RegExp(`^\\s+${valueName}\\s+REG_SZ\\s+(.+?)\\s*$`, "i");
  const out: Array<[string, string]> = [];
  let currentKey = "";
  for (const raw of stdout.split(/\r?\n/)) {
    if (/^HKEY_/i.test(raw.trim())) {
      currentKey = raw.trim();
    } else {
      const m = raw.match(valueRe);
      if (m && currentKey) {
        const parts = currentKey.split("\\");
        out.push([parts[parts.length - 1], m[1]]);
      }
    }
  }
  return out;
}

/** The registry hives/subkeys probed for Eagle Dynamics install `Path` values. */
export const REGISTRY_INSTALL_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["HKCU", "Software\\Eagle Dynamics"],
  ["HKLM", "SOFTWARE\\Eagle Dynamics"],
];

/** Whether a `Saved Games` entry name is a DCS write dir (`DCS` or `DCS.<variant>`). */
export function isDcsSavedName(name: string): boolean {
  return name === "DCS" || name.startsWith("DCS.");
}

/** Ordering for Saved Games candidates: plain `DCS` first, then variants A→Z. */
export function compareSavedNames(a: string, b: string): number {
  return Number(a !== "DCS") - Number(b !== "DCS") || a.localeCompare(b);
}

/** Validity/detail for a Saved Games dir, keyed on whether it has a `Config` subdir. */
export function savedGameDetail(hasConfig: boolean): { valid: boolean; detail: string } {
  return { valid: hasConfig, detail: hasConfig ? "has Config" : "no Config yet — run DCS once" };
}

const INSTALL_DRIVES = ["C", "D", "E"];
const INSTALL_LEAVES = ["DCS World", "DCS World OpenBeta", "DCS World Server"];

/** The Program Files roots probed for a game install, in drive×variant order. */
export function programFilesInstallRoots(): Array<{ name: string; root: string }> {
  const out: Array<{ name: string; root: string }> = [];
  for (const drive of INSTALL_DRIVES) {
    for (const leaf of INSTALL_LEAVES) {
      out.push({ name: leaf, root: `${drive}:\\Program Files\\Eagle Dynamics\\${leaf}` });
    }
  }
  return out;
}

/** Validity/detail for a game install, keyed on whether it has `bin\DCS.exe`. */
export function installDetail(hasExe: boolean): { valid: boolean; detail: string } {
  return { valid: hasExe, detail: hasExe ? "bin\\DCS.exe found" : "no bin\\DCS.exe" };
}

/** Ordering for game-install candidates: by display name A→Z. */
export function compareInstallNames(a: string, b: string): number {
  return a.localeCompare(b);
}

export type SetupRole = "saved" | "install" | "data" | "sevenzip";

/**
 * The absolute path whose existence decides a hand-picked path's validity for its
 * Setup role, or `null` when the role has no probe (a `data` dir — any writable
 * folder is fine):
 *  - install  → `<target>\bin\DCS.exe`
 *  - sevenzip → `<target>` itself
 *  - saved / undefined → `<target>\Config`
 */
export function roleProbePath(role: SetupRole | undefined, target: string): string | null {
  switch (role) {
    case "install":
      return path.join(target, "bin", "DCS.exe");
    case "data":
      return null;
    case "sevenzip":
      return target;
    default:
      return path.join(target, "Config");
  }
}
