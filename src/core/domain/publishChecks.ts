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

/** The probed state of one `[[bundle]]` path. */
export interface SourceProbe {
  source: string;
  /** The path does not exist (an `lstat` threw). */
  missing: boolean;
  /** The path exists and is a symbolic link (refused by the packager). */
  symlink: boolean;
}

/** Normalize a project-relative path for comparison (slashes, trailing slash). */
function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Whether a `[[symlink]].source` is covered by some `[[bundle]].path` — equal to
 * it, or nested inside it. A bundle path of `.` (or empty) is the whole project
 * and covers everything. Coverage is what lets a mod bundle a folder and link
 * only one file inside it; an uncovered source would link a path the payload
 * never shipped.
 */
export function isCoveredByBundle(source: string, bundlePaths: string[]): boolean {
  const s = normPath(source);
  return bundlePaths.some((p) => {
    const b = normPath(p);
    return b === "" || b === "." || s === b || s.startsWith(`${b}/`);
  });
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
  /** One probe per `[[bundle]]` path (only meaningful when a manifest has bundles). */
  bundle: SourceProbe[];
  /** The resolved 7-Zip command/path, or null when unavailable. */
  sevenZip: string | null;
  /** Whether git is available on PATH. */
  gitAvailable: boolean;
  /** gh CLI presence + auth. */
  gh: GhFacts;
}

/** GitHub CLI presence + auth as a Check (used standalone and inside preflight). */
export function computeGhCheck(gh: GhFacts): Check {
  if (!gh.present)
    return {
      label: "GitHub CLI",
      level: "error",
      detail: "gh not found. Install from cli.github.com.",
    };
  if (!gh.authed)
    return {
      label: "GitHub CLI",
      level: "error",
      detail: "gh is not signed in. Run: gh auth login",
    };
  return { label: "GitHub CLI", level: "ok", detail: "signed in" };
}

/** The ordered preflight checks derived purely from the gathered facts. */
export function computePreflight(facts: PreflightFacts): Check[] {
  const checks: Check[] = [];
  if (!facts.manifestExists) {
    checks.push({
      label: "Manifest",
      level: "error",
      detail: "dcs-studio.toml not found in the workspace root.",
    });
  } else if (!facts.manifest) {
    checks.push({ label: "Manifest", level: "error", detail: "Could not parse dcs-studio.toml." });
  } else {
    const m = facts.manifest;
    checks.push(
      m.project.name.trim()
        ? { label: "Project name", level: "ok", detail: m.project.name }
        : { label: "Project name", level: "error", detail: "[project] name is required." },
    );
    // Pre-release breaking change (2026-07): [[install]] is no longer modeled —
    // it parses into extras and installs nothing. Fail loudly rather than let a
    // mod publish that silently does nothing on enable.
    if (m.extras.some((x) => /^\s*\[\[install\]\]/m.test(x))) {
      checks.push({
        label: "Manifest",
        level: "error",
        detail:
          "[[install]] is no longer supported — replace each rule with [[bundle]] path = <source> and [[symlink]] source/dest.",
      });
    }
    if (!m.bundle.length) {
      checks.push({
        label: "Bundle paths",
        level: "warn",
        detail: "No [[bundle]] paths — the release will ship only the manifest.",
      });
    } else {
      const missing = facts.bundle.filter((s) => s.missing).map((s) => s.source);
      const symlinks = facts.bundle.filter((s) => !s.missing && s.symlink).map((s) => s.source);
      if (missing.length) {
        checks.push({
          label: "Bundle paths",
          level: "error",
          detail: `${missing.length} of ${m.bundle.length} bundle path(s) missing — build the project first.`,
          items: missing.map((s) => `missing: ${s}`),
        });
      } else if (symlinks.length) {
        checks.push({
          label: "Bundle paths",
          level: "error",
          detail: `${symlinks.length} bundle path(s) are symlinks (refused by the packager).`,
          items: symlinks.map((s) => `symlink: ${s}`),
        });
      } else {
        checks.push({
          label: "Bundle paths",
          level: "ok",
          detail: `${m.bundle.length} bundle path(s) present.`,
        });
      }
    }
    // Every symlink source must live inside bundled content, or the link would
    // point at a file the payload never shipped. Pure check — no fs needed.
    if (m.symlink.length) {
      const bundlePaths = m.bundle.map((b) => b.path);
      const uncovered = m.symlink
        .filter((s) => !isCoveredByBundle(s.source, bundlePaths))
        .map((s) => s.source);
      if (uncovered.length) {
        checks.push({
          label: "Symlink coverage",
          level: "error",
          detail: `${uncovered.length} symlink source(s) not inside any [[bundle]] path.`,
          items: uncovered.map((s) => `not bundled: ${s}`),
        });
      } else {
        checks.push({
          label: "Symlink coverage",
          level: "ok",
          detail: `${m.symlink.length} symlink(s) covered by bundled content.`,
        });
      }
    }
    // Executable entrypoints: every exe must ship inside a bundled path (or the
    // installed mod could never launch it), and ids must be unique so the ledger
    // and launch tracking can key on them. Exe-only mods (entrypoints, no
    // symlinks) are perfectly valid — they still bundle the exe. Pure checks.
    if (m.entrypoint.length) {
      const bundlePaths = m.bundle.map((b) => b.path);
      const uncovered = m.entrypoint
        .filter((e) => !isCoveredByBundle(e.exe, bundlePaths))
        .map((e) => e.exe);
      const ids = m.entrypoint.map((e) => e.id);
      const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
      if (uncovered.length) {
        checks.push({
          label: "Executables",
          level: "error",
          detail: `${uncovered.length} entrypoint exe(s) not inside any [[bundle]] path.`,
          items: uncovered.map((e) => `not bundled: ${e}`),
        });
      } else if (dupes.length) {
        checks.push({
          label: "Executables",
          level: "error",
          detail: `${dupes.length} duplicate entrypoint id(s) — each [[entrypoint]] id must be unique.`,
          items: dupes.map((id) => `duplicate id: ${id}`),
        });
      } else {
        checks.push({
          label: "Executables",
          level: "ok",
          detail: `${m.entrypoint.length} entrypoint(s) covered by bundled content.`,
        });
      }
    }
    // Mission scripts: each declares a Lua file run at mission start via the
    // managed MissionScripting.lua entrypoint. The path must ship inside a
    // bundle (or the aggregator would dofile a file the payload never sent),
    // run_on must be one of the two known timings, and a name is required (it
    // becomes the aggregator's tag and the subscriber-facing label). Pure check.
    if (m.mission_script.length) {
      const bundlePaths = m.bundle.map((b) => b.path);
      const uncovered = m.mission_script
        .filter((s) => !isCoveredByBundle(s.path, bundlePaths))
        .map((s) => s.path);
      const badRunOn = m.mission_script
        .filter((s) => s.run_on !== "before-sanitize" && s.run_on !== "after-sanitize")
        .map((s) => s.path || "(no path)");
      const unnamed = m.mission_script.filter((s) => !s.name.trim()).length;
      if (uncovered.length) {
        checks.push({
          label: "Mission scripts",
          level: "error",
          detail: `${uncovered.length} mission script path(s) not inside any [[bundle]] path.`,
          items: uncovered.map((s) => `not bundled: ${s}`),
        });
      } else if (badRunOn.length) {
        checks.push({
          label: "Mission scripts",
          level: "error",
          detail: `${badRunOn.length} mission script(s) with an invalid run_on (must be "before-sanitize" or "after-sanitize").`,
          items: badRunOn.map((s) => `invalid run_on: ${s}`),
        });
      } else if (unnamed) {
        checks.push({
          label: "Mission scripts",
          level: "error",
          detail: `${unnamed} mission script(s) with an empty name.`,
        });
      } else {
        checks.push({
          label: "Mission scripts",
          level: "ok",
          detail: `${m.mission_script.length} mission script(s) covered by bundled content.`,
        });
      }
    }
  }

  checks.push(
    facts.sevenZip
      ? { label: "7-Zip", level: "ok", detail: facts.sevenZip }
      : {
          label: "7-Zip",
          level: "error",
          detail: "7z not found. Install 7-Zip (7-zip.org) and retry.",
        },
  );
  checks.push(
    facts.gitAvailable
      ? { label: "git", level: "ok", detail: "available" }
      : { label: "git", level: "error", detail: "git not found on PATH." },
  );
  checks.push(computeGhCheck(facts.gh));
  return checks;
}
