import * as path from "node:path";
import type { InstallRoots, ManifestEntrypoint } from "./types";

// Pure launch-decision policy for executable entrypoints: resolve an entrypoint's
// exe/cwd/args against the mod's unpacked dir + the DCS install roots, expand the
// `{SavedGames}`/`{GameInstall}` tokens in args, and derive the consent-memento
// key + the running-map key. NO I/O and NO process spawning — the node adapter
// (src/adapters/node/processLauncher.ts) takes a resolved plan and spawns it.
//
// DCS is Windows-only, so paths resolve with the Windows semantics
// (`path.win32`) regardless of the host the tests run on — deterministic.

/** A resolved, ready-to-spawn plan for one entrypoint. */
export interface EntrypointLaunchPlan {
  /** Absolute path to the executable inside the unpacked mod dir. */
  exe: string;
  /** Absolute working directory (declared `cwd`, else the exe's directory). */
  cwd: string;
  /** Args with root tokens expanded. */
  args: string[];
}

/** Expand `{SavedGames}`/`{GameInstall}` tokens in one arg string. */
export function expandArgTokens(arg: string, roots: InstallRoots): string {
  return arg
    .replace(/\{SavedGames\}/g, roots.savedGames)
    .replace(/\{GameInstall\}/g, roots.gameInstall || "");
}

/**
 * Resolve an entrypoint into an absolute launch plan. `exe` and `cwd` are joined
 * under `unpackedDir` (Windows join); when `cwd` is absent it defaults to the
 * directory containing the exe. Args have their root tokens expanded.
 */
export function resolveEntrypointLaunch(
  ep: ManifestEntrypoint,
  unpackedDir: string,
  roots: InstallRoots,
): EntrypointLaunchPlan {
  const exe = path.win32.join(unpackedDir, ep.exe);
  const cwd = ep.cwd ? path.win32.join(unpackedDir, ep.cwd) : path.win32.dirname(exe);
  const args = (ep.args ?? []).map((a) => expandArgTokens(a, roots));
  return { exe, cwd, args };
}

/**
 * The globalState memento key recording that a user granted "always allow" for a
 * given mod+entrypoint. Keyed by lowercased repo + entrypoint id so it is stable
 * and case-insensitive (mirrors the ledger key rule).
 */
export function entrypointConsentKey(repo: string, entrypointId: string): string {
  return `dcs.entrypointConsent.${repo.toLowerCase()}:${entrypointId}`;
}

/**
 * The key identifying one running entrypoint in the launcher's tracking map and
 * in the webview's running state. Repo is lowercased for case-insensitive match.
 */
export function entrypointRunKey(repo: string, entrypointId: string): string {
  return `${repo.toLowerCase()}::${entrypointId}`;
}
