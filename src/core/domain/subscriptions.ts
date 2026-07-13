// Pure subscription domain: the ledger key rules, the data-dir key, the
// Subscription/ModLink shapes (re-exported from the shared types module), plus
// the two view/policy helpers the panels need (Subscription→DTO projection and
// the "already up to date" rule) and the pure `uninstall-all.bat` renderer.
//
// NOTHING here does I/O. The persisted ledger shape (`Record<lowercased repo,
// Subscription>`) and the generated `uninstall-all.bat` bytes are FROZEN — this
// module is the single source of truth for both.

import type { Subscription, ModLink } from "./types";

// The Subscription/ModLink shapes live in the shared types module; re-export them
// so subscription code can import everything it needs from one place.
export type { Subscription, ModLink };

/** The manifest file name a subscribed mod ships (asset + on-disk). */
export const MANIFEST = "dcs-studio.toml";

/**
 * The ledger key for a repo — lowercased `owner/name`. The ledger is keyed by
 * this so lookups are case-insensitive; the on-disk shape is frozen to it.
 */
export function ledgerKey(repo: string): string {
  return repo.toLowerCase();
}

/**
 * The data-dir folder name for a repo — slashes replaced with `__` so a repo maps
 * to a single flat directory under `<dataDir>`. Distinct from the ledger key.
 */
export function keyOf(repo: string): string {
  return repo.replace(/[\\/]/g, "__");
}

/** The list DTO the My Mods webview renders for a subscription. */
export interface ModDto {
  repo: string;
  name: string;
  tag: string;
  enabled: boolean;
  dir: string;
  links: number;
}

/** Project a subscription to the My Mods list DTO (link count, not the links). */
export function toModDto(s: Subscription): ModDto {
  return { repo: s.repo, name: s.name, tag: s.tag, enabled: s.enabled, dir: s.dir, links: s.links.length };
}

/** Whether a subscription is already on `releaseTag` (skip the update). */
export function isUpToDate(sub: Subscription, releaseTag: string): boolean {
  return releaseTag === sub.tag;
}

/** Subscriptions sorted for display — by name, case-insensitively (locale-aware). */
export function sortedByName(subs: Record<string, Subscription>): Subscription[] {
  return Object.values(subs).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Render `uninstall-all.bat` — a self-contained escape hatch that removes every
 * mod link from the DCS folders, then the unpacked mod data, without needing the
 * extension. Junctions are removed with `rmdir` (never `rmdir /s`, which would
 * delete THROUGH the link); file links with `del`. Real data dirs use `rmdir /s`.
 *
 * PURE: returns the exact file contents (CRLF line endings, trailing newline).
 * `dataDir` is accepted for call-site symmetry with the writer; the bytes depend
 * only on the ledger and the subscriptions-file path.
 */
export function renderUninstallScript(
  subs: Record<string, Subscription>,
  dataDir: string,
  subsFilePath: string,
): string {
  void dataDir;
  const q = (p: string) => `"${p.replace(/"/g, "")}"`;
  const lines: string[] = [
    "@echo off",
    "REM ============================================================",
    "REM  DCS Studio — clean uninstall",
    "REM  Removes every mod link from your DCS folders, then the",
    "REM  unpacked mod data. Run this if things break or to wipe all",
    "REM  DCS Studio mods in one go. Maintained by the extension.",
    "REM ============================================================",
    "setlocal",
    "echo Removing DCS Studio mod links...",
  ];
  for (const s of Object.values(subs)) {
    for (const l of s.links) {
      // A dir (junction) -> rmdir removes the link only; a file link -> del.
      lines.push(`if exist ${q(l.dest + "\\")} ( rmdir ${q(l.dest)} ) else ( if exist ${q(l.dest)} del /f /q ${q(l.dest)} )`);
    }
  }
  lines.push("echo Removing unpacked mod data...");
  for (const s of Object.values(subs)) {
    lines.push(`if exist ${q(s.dir)} rmdir /s /q ${q(s.dir)}`);
  }
  lines.push(
    `if exist ${q(subsFilePath)} del /f /q ${q(subsFilePath)}`,
    "echo.",
    "echo Done. All DCS Studio mods have been removed.",
    "pause",
  );
  return lines.join("\r\n") + "\r\n";
}
