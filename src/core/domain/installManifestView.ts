// Pure install-manifest view-model. Turns a mod's parsed manifest surface (the
// bundled content, symlinks, executable entrypoints and mission-script hooks it
// declares) into the exact shape the product page and My Mods render: normalized
// per-section lists, per-section counts, and the ordered risk flags a subscriber
// must see BEFORE installing — `links-files`, `runs-executable`,
// `pre-sanitize-script`. NO DOM, NO I/O — the panels (adapters) call this and
// post the result to their webviews, and the webviews render it verbatim.
//
// The `known` flag is load-bearing: when a release's manifest could not be read
// (absent asset, download/parse failure) the caller passes `null` and this
// returns the explicit UNKNOWN view — every list empty, `known:false` — so the
// UI can render a blocking "install actions unknown" state rather than silently
// omitting sections. A mod that declares privileged actions therefore can never
// render without its warnings: the risks derive from the same surface as the
// sections, so if the surface is known the flags are present, and if it is not
// known the UI shows the unknown state instead of a clean (warning-free) page.
//
// The same surface also decides whether the mod may be installed at all. Every
// declared path is measured against the shared containment predicate
// (./pathContainment), and each one that reaches outside its root is listed in
// `unsafePaths` with the row it came from flagged `escapes`. That is what lets
// the product page refuse the mod with a reason at plan time — before anything
// is downloaded — rather than discovering it halfway through linking.

import { destStaysUnder, staysUnder } from "./pathContainment";
import type { ManifestEntrypoint, ManifestMissionScript, MissionScriptRunOn } from "./types";

/** The raw parsed manifest surface fed to the view-model. */
export interface InstallManifestInput {
  /** `[[bundle]]` paths packed into the release payload. */
  bundles: { path: string }[];
  /**
   * `[[symlink]]` rules. `resolved` is the absolute destination when the caller
   * could resolve it against the DCS roots (the marketplace does, via the
   * manifest port); `null`/absent means show the token `dest` as-is (My Mods,
   * which renders the declared destination without resolving).
   */
  symlinks: { source: string; dest: string; resolved?: string | null }[];
  /** `[[entrypoint]]` executables. */
  entrypoints: ManifestEntrypoint[];
  /** `[[mission_script]]` hooks. */
  missionScripts: ManifestMissionScript[];
}

/** A normalized symlink row for display. */
export interface SymlinkView {
  source: string;
  dest: string;
  resolved: string | null;
  /** True when this row's source or dest reaches outside its root. */
  escapes: boolean;
}

/** A normalized entrypoint row for display. */
export interface EntrypointView {
  id: string;
  name: string;
  exe: string;
  args: string[];
  cwd: string | null;
  /** True when this row's exe or cwd reaches outside the unpacked mod dir. */
  escapes: boolean;
}

/** A normalized mission-script row for display. */
export interface MissionScriptView {
  name: string;
  purpose: string | null;
  path: string;
  run_on: MissionScriptRunOn;
  /** True for `run_on = "before-sanitize"` — the unsandboxed, privileged case. */
  beforeSanitize: boolean;
  /** True when this row's path reaches outside the unpacked mod dir. */
  escapes: boolean;
}

/** Which declared path failed containment — decides how it is described. */
export type UnsafePathKind =
  | "symlink-dest"
  | "symlink-source"
  | "entrypoint-exe"
  | "entrypoint-cwd"
  | "mission-script-path";

/** One declared path that reaches outside the root it would be joined onto. */
export interface UnsafePath {
  kind: UnsafePathKind;
  /** The path exactly as the manifest declared it — never normalized away. */
  value: string;
  /** A one-line, user-facing explanation naming the offending path. */
  reason: string;
}

/** How each kind of offending path is named to the user. */
const UNSAFE_SUBJECT: Record<UnsafePathKind, string> = {
  "symlink-dest": "Link destination",
  "symlink-source": "Link source",
  "entrypoint-exe": "Executable",
  "entrypoint-cwd": "Executable working directory",
  "mission-script-path": "Mission script",
};

/**
 * Describe one containment failure. A dest is joined onto a DCS root; every
 * other declared path is joined onto the mod's own unpacked directory, so the
 * two get different wording for what they escaped.
 */
function unsafePath(kind: UnsafePathKind, value: string): UnsafePath {
  const root = kind === "symlink-dest" ? "the configured DCS folders" : "the mod's own folder";
  return { kind, value, reason: `${UNSAFE_SUBJECT[kind]} "${value}" reaches outside ${root}.` };
}

function symlinkEscapes(s: { source: string; dest: string }): UnsafePath[] {
  const out: UnsafePath[] = [];
  if (!destStaysUnder(s.dest)) out.push(unsafePath("symlink-dest", s.dest));
  if (!staysUnder(s.source)) out.push(unsafePath("symlink-source", s.source));
  return out;
}

function entrypointEscapes(e: ManifestEntrypoint): UnsafePath[] {
  const out: UnsafePath[] = [];
  if (!staysUnder(e.exe)) out.push(unsafePath("entrypoint-exe", e.exe));
  // `cwd` is optional and defaults to the exe's own directory; only a declared
  // one can escape.
  if (e.cwd && !staysUnder(e.cwd)) out.push(unsafePath("entrypoint-cwd", e.cwd));
  return out;
}

function missionScriptEscapes(m: ManifestMissionScript): UnsafePath[] {
  return staysUnder(m.path) ? [] : [unsafePath("mission-script-path", m.path)];
}

/**
 * Every declared path in the surface that reaches outside its root, in the
 * order the sections are declared. Empty means the manifest is safe to act on.
 *
 * This is the gate the install path shares with the product page: the page
 * refuses to offer the mod, and the subscription service refuses to record or
 * link it, from this one list.
 */
export function unsafeManifestPaths(input: InstallManifestInput): UnsafePath[] {
  return [
    ...input.symlinks.flatMap(symlinkEscapes),
    ...input.entrypoints.flatMap(entrypointEscapes),
    ...input.missionScripts.flatMap(missionScriptEscapes),
  ];
}

/** The refusal message for a manifest that failed containment. */
export function unsafeManifestMessage(unsafe: UnsafePath[]): string {
  return `This mod's manifest asks to write outside your DCS folders. ${unsafe
    .map((u) => u.reason)
    .join(" ")}`;
}

/** Per-section item counts (drive the section-header badges). */
export interface InstallManifestCounts {
  bundles: number;
  symlinks: number;
  entrypoints: number;
  missionScripts: number;
  /** How many mission scripts run before DCS's sandbox (the orange badge). */
  beforeSanitize: number;
}

/**
 * The privileged actions a subscriber must see up-front, in decreasing order of
 * how routine they are: linking files is common, launching an executable is
 * notable, and injecting pre-sanitization Lua is the highest-privilege action.
 */
export type RiskFlag = "links-files" | "runs-executable" | "pre-sanitize-script";

/** The rendered view-model for a mod's install manifest. */
export interface InstallManifestView {
  /** False when the release manifest could not be read (the unknown state). */
  known: boolean;
  bundles: { path: string }[];
  symlinks: SymlinkView[];
  entrypoints: EntrypointView[];
  missionScripts: MissionScriptView[];
  counts: InstallManifestCounts;
  risks: RiskFlag[];
  /**
   * Declared paths that reach outside their root. Non-empty means the mod must
   * not be offered for install — the UI shows these reasons in place of the
   * install action.
   */
  unsafePaths: UnsafePath[];
}

/** The explicit "manifest could not be read" view — empty, `known:false`. */
function unknownView(): InstallManifestView {
  return {
    known: false,
    bundles: [],
    symlinks: [],
    entrypoints: [],
    missionScripts: [],
    counts: { bundles: 0, symlinks: 0, entrypoints: 0, missionScripts: 0, beforeSanitize: 0 },
    risks: [],
    unsafePaths: [],
  };
}

/**
 * Derive the install-manifest view-model. Pass `null` when the manifest is
 * unreadable/absent to get the explicit unknown state; otherwise the surface is
 * normalized into display rows, counts and ordered risk flags.
 */
export function deriveInstallManifestView(input: InstallManifestInput | null): InstallManifestView {
  if (!input) return unknownView();

  const bundles = input.bundles.map((b) => ({ path: b.path }));
  const symlinks: SymlinkView[] = input.symlinks.map((s) => ({
    source: s.source,
    dest: s.dest,
    resolved: s.resolved ?? null,
    escapes: symlinkEscapes(s).length > 0,
  }));
  const entrypoints: EntrypointView[] = input.entrypoints.map((e) => ({
    id: e.id,
    name: e.name,
    exe: e.exe,
    args: e.args ?? [],
    cwd: e.cwd ?? null,
    escapes: entrypointEscapes(e).length > 0,
  }));
  const missionScripts: MissionScriptView[] = input.missionScripts.map((m) => ({
    name: m.name,
    purpose: m.purpose ?? null,
    path: m.path,
    run_on: m.run_on,
    beforeSanitize: m.run_on === "before-sanitize",
    escapes: missionScriptEscapes(m).length > 0,
  }));

  const beforeSanitize = missionScripts.filter((m) => m.beforeSanitize).length;
  const counts: InstallManifestCounts = {
    bundles: bundles.length,
    symlinks: symlinks.length,
    entrypoints: entrypoints.length,
    missionScripts: missionScripts.length,
    beforeSanitize,
  };

  const risks: RiskFlag[] = [];
  if (symlinks.length > 0) risks.push("links-files");
  if (entrypoints.length > 0) risks.push("runs-executable");
  if (beforeSanitize > 0) risks.push("pre-sanitize-script");

  return {
    known: true,
    bundles,
    symlinks,
    entrypoints,
    missionScripts,
    counts,
    risks,
    unsafePaths: unsafeManifestPaths(input),
  };
}
