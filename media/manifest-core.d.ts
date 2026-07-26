// Hand-written declarations for the UMD module `manifest-core.js`.
//
// The .js is `@ts-nocheck` browser-and-Node source the webview loads as a plain
// <script>, so it cannot be typechecked in place; turning `allowJs` on for the
// test compilation unit instead types the whole module by inference and gets
// `any` for most of it. This file is the module's API stated once, deliberately,
// so a test that calls a function manifest-core does not export — or passes a
// model shape it does not produce — is a compile error rather than a runtime
// `undefined is not a function`.
//
// It must stay in step with the object the factory returns at the bottom of
// manifest-core.js: everything listed there, nothing that is not.

/** The DCS roots a `{SavedGames}` / `{GameInstall}` dest resolves against.
 * `gameInstall` is empty (or absent) on a machine where it is unconfigured. */
export interface ManifestRoots {
  savedGames: string;
  gameInstall?: string;
}

/** `[project]`. Only `name` is modeled as required — unmodeled keys
 * (`template`, `dcs_min_version`, …) are kept verbatim and re-emitted. */
export interface ManifestProject {
  name: string;
  version?: string;
  author?: string;
  description?: string;
  [key: string]: unknown;
}

// Every row interface carries a `[key: string]: unknown` index signature for
// the same reason `[project]` does: parseToml writes back EVERY key it finds in
// a modeled section, and an unmodeled one keeps its parsed TOML type so
// emitToml can round-trip it.

/** `[[bundle]]` — what gets packed into the release archive. */
export interface ManifestBundle {
  path: string;
  [key: string]: unknown;
}

/** `[[symlink]]` — a link created on enable; `dest` carries a root token. */
export interface ManifestSymlink {
  source: string;
  dest: string;
  [key: string]: unknown;
}

/** `[[requires_module]]` — a DCS module the mod needs. */
export interface ManifestRequiresModule {
  id: string;
  name?: string;
  [key: string]: unknown;
}

/** `[[entrypoint]]` — an executable My Mods can launch as a tracked process. */
export interface ManifestEntrypoint {
  id: string;
  name?: string;
  exe: string;
  args?: string[];
  cwd?: string;
  [key: string]: unknown;
}

/** `[[mission_script]]` — Lua run at mission start via MissionScripting.lua. */
export interface ManifestMissionScript {
  name: string;
  purpose?: string;
  path: string;
  run_on?: string;
  [key: string]: unknown;
}

/** The five `[[array]]` sections the model stores first-class (manifest-core's
 * own MODELED_ARRAYS). Anything else is an unmodeled section and lands in
 * `extras`, which is why this is not simply `keyof ManifestModel`. */
export type ManifestArraySection =
  | "bundle"
  | "symlink"
  | "requires_module"
  | "entrypoint"
  | "mission_script";

/**
 * A parsed manifest. The six modeled collections are always present (both
 * `emptyModel` and `parseToml` create them), which is why the consumers iterate
 * them without guarding; `extras` holds the verbatim text of every section the
 * form does not model.
 */
export interface ManifestModel {
  project: ManifestProject;
  bundle: ManifestBundle[];
  symlink: ManifestSymlink[];
  requires_module: ManifestRequiresModule[];
  entrypoint: ManifestEntrypoint[];
  mission_script: ManifestMissionScript[];
  extras: string[];
}

/** A TOML scalar as `parseVal` returns it — quoted strings unquote, `true` /
 * `false` and integers coerce, an inline array parses element-wise, and
 * anything else keeps its literal source text. */
export type TomlValue = string | number | boolean | TomlValue[];

export interface DcsManifestCoreApi {
  /** The dest prefixes a manifest may name, in `splitDest` precedence order. */
  readonly ROOT_TOKENS: string[];
  /** The two legal `[[mission_script]] run_on` values, safe default first. */
  readonly MISSION_SCRIPT_RUN_ON: string[];
  emptyModel(): ManifestModel;
  parseVal(v: string): TomlValue;
  parseToml(text: string): ManifestModel;
  /** TOML-quote a value (a nullish one becomes `""`). */
  q(s: unknown): string;
  emitToml(m: ManifestModel): string;
  splitDest(dest: string): { root: string; rest: string };
  winJoin(base: string, rest: string): string;
  staysUnder(p: string): boolean;
  destStaysUnder(dest: string): boolean;
  /** Absolute path for a dest, or null when it escapes the roots or names an
   * unconfigured `{GameInstall}`. */
  resolveDest(dest: string, roots: ManifestRoots): string | null;
  /** Every authoring problem in `m`, as ready-to-show sentences. */
  issues(m: ManifestModel, roots: ManifestRoots): string[];
}

declare const DcsManifestCore: DcsManifestCoreApi;
export default DcsManifestCore;
