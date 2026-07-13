import type { ManifestModel } from "./types";

// Pure preflight policy: the publish panel's readiness checks expressed as
// functions over injected FACTS (manifest presence/parse, per-source fs probes,
// tool availability, gh auth) rather than I/O. The preflight adapter gathers the
// facts (fs + spawn) and delegates here; this file does no I/O of its own.

/** A single preflight readiness check rendered in the publish panel. */
export interface Check {
  label: string;
  level: "ok" | "warn" | "error";
  detail: string;
  /** Per-item breakdown rendered under the detail line (e.g. each missing source path). */
  items?: string[];
}

/** The probed state of one `[[install]]` source path. */
export interface SourceProbe {
  source: string;
  /** The path does not exist (an `lstat` threw). */
  missing: boolean;
  /** The path exists and is a symbolic link (refused by the packager). */
  symlink: boolean;
}

/** gh CLI presence + auth facts. */
export interface GhFacts {
  present: boolean;
  authed: boolean;
}

/** Everything the preflight policy needs, gathered by the adapter. */
export interface PreflightFacts {
  /** Whether `dcs-studio.toml` exists in the workspace root. */
  manifestExists: boolean;
  /** The parsed manifest, or null when absent/unparseable. */
  manifest: ManifestModel | null;
  /** One probe per `[[install]]` source (only meaningful when a manifest has rules). */
  sources: SourceProbe[];
  /** The resolved 7-Zip command/path, or null when unavailable. */
  sevenZip: string | null;
  /** Whether git is available on PATH. */
  gitAvailable: boolean;
  /** gh CLI presence + auth. */
  gh: GhFacts;
}

/** GitHub CLI presence + auth as a Check (used standalone and inside preflight). */
export function computeGhCheck(gh: GhFacts): Check {
  if (!gh.present) return { label: "GitHub CLI", level: "error", detail: "gh not found. Install from cli.github.com." };
  if (!gh.authed) return { label: "GitHub CLI", level: "error", detail: "gh is not signed in. Run: gh auth login" };
  return { label: "GitHub CLI", level: "ok", detail: "signed in" };
}

/** The ordered preflight checks derived purely from the gathered facts. */
export function computePreflight(facts: PreflightFacts): Check[] {
  const checks: Check[] = [];
  if (!facts.manifestExists) {
    checks.push({ label: "Manifest", level: "error", detail: "dcs-studio.toml not found in the workspace root." });
  } else if (!facts.manifest) {
    checks.push({ label: "Manifest", level: "error", detail: "Could not parse dcs-studio.toml." });
  } else {
    const m = facts.manifest;
    checks.push(
      m.project.name.trim()
        ? { label: "Project name", level: "ok", detail: m.project.name }
        : { label: "Project name", level: "error", detail: "[project] name is required." },
    );
    if (!m.install.length) {
      checks.push({ label: "Install rules", level: "warn", detail: "No [[install]] rules — the release will ship only the manifest." });
    } else {
      const missing = facts.sources.filter((s) => s.missing).map((s) => s.source);
      const symlinks = facts.sources.filter((s) => !s.missing && s.symlink).map((s) => s.source);
      if (missing.length) {
        checks.push({
          label: "Install sources",
          level: "error",
          detail: `${missing.length} of ${m.install.length} source(s) missing — build the project first.`,
          items: missing.map((s) => `missing: ${s}`),
        });
      } else if (symlinks.length) {
        checks.push({
          label: "Install sources",
          level: "error",
          detail: `${symlinks.length} source(s) are symlinks (refused by the packager).`,
          items: symlinks.map((s) => `symlink: ${s}`),
        });
      } else {
        checks.push({ label: "Install sources", level: "ok", detail: `${m.install.length} source(s) present.` });
      }
    }
  }

  checks.push(
    facts.sevenZip
      ? { label: "7-Zip", level: "ok", detail: facts.sevenZip }
      : { label: "7-Zip", level: "error", detail: "7z not found. Install 7-Zip (7-zip.org) and retry." },
  );
  checks.push(
    facts.gitAvailable
      ? { label: "git", level: "ok", detail: "available" }
      : { label: "git", level: "error", detail: "git not found on PATH." },
  );
  checks.push(computeGhCheck(facts.gh));
  return checks;
}
