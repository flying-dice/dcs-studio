// Core-owned domain data types. These carry the shapes that ports exchange with
// the outside world. NOTHING here imports `vscode`, Node I/O, or `src/adapters`
// — they are plain data. Adapters map their native results into these types.

/** A single link a mod declares between an unpacked asset and a DCS destination. */
export interface ModLink {
  id: string;
  dest: string;
}

/**
 * A declared executable entrypoint a mod can launch as a tracked process.
 * `exe`/`cwd` are paths relative to the unpacked mod dir; `args` may contain
 * `{SavedGames}`/`{GameInstall}` tokens expanded at launch. Mirrors a
 * `[[entrypoint]]` block in media/manifest-core.js.
 */
export interface ManifestEntrypoint {
  id: string;
  name: string;
  exe: string;
  args?: string[];
  cwd?: string;
}

/** Which side of MissionScripting.lua's sanitize lockdown a mod script runs on. */
export type MissionScriptRunOn = "before-sanitize" | "after-sanitize";

/**
 * A Lua script a mod wants run at mission start via DCS Studio's managed
 * MissionScripting.lua entrypoint. `path` is project/bundle-relative (covered by
 * a `[[bundle]]` entry, exactly like an entrypoint `exe`); the aggregator dofiles
 * the file from its unpacked location. `run_on="before-sanitize"` runs with the
 * FULL unsanitized Lua environment (os/io/lfs/require) — a security-sensitive
 * capability surfaced with warnings. Mirrors a `[[mission_script]]` block in
 * media/manifest-core.js.
 */
export interface ManifestMissionScript {
  name: string;
  purpose?: string;
  path: string;
  run_on: MissionScriptRunOn;
}

/** A subscribed mod's persisted ledger entry (`subscriptions.json` value). */
export interface Subscription {
  repo: string;
  name: string;
  tag: string;
  /** `<dataDir>/<key>` — where the payload is unpacked. */
  dir: string;
  enabled: boolean;
  links: ModLink[];
  /**
   * Bundled content the mod ships (`[[bundle]]` paths), snapshotted from its
   * manifest at subscribe time so My Mods can show the same install breakdown the
   * product page shows without re-fetching. Absent on older ledgers — read
   * defensively (`?? []`).
   */
  bundles: { path: string }[];
  /**
   * Symlink rules the mod declares (`[[symlink]]` source → dest), snapshotted at
   * subscribe time for the My Mods install breakdown. Dests are the declared
   * token paths (`{SavedGames}/…`); My Mods shows them unresolved. Absent on
   * older ledgers — read defensively (`?? []`).
   */
  symlinks: { source: string; dest: string }[];
  /**
   * Executable entrypoints the mod declares, snapshotted from its manifest at
   * subscribe time so My Mods can offer Launch/Stop without re-fetching. Absent
   * on ledgers written before this field existed — read defensively (`?? []`).
   */
  entrypoints: ManifestEntrypoint[];
  /**
   * Mission scripts the mod declares, snapshotted from its manifest at subscribe
   * time so the pre/post-sanitize aggregators can be regenerated on every
   * enable/disable without re-fetching manifests. Absent on older ledgers —
   * read defensively (`?? []`).
   */
  missionScripts: ManifestMissionScript[];
}

/** The DCS install roots a manifest destination is resolved against. */
export interface InstallRoots {
  savedGames: string;
  gameInstall: string;
}

/**
 * Parsed `dcs-studio.toml` model (mirrors media/manifest-core.js output).
 *
 * `bundle` is what gets packed into the release 7z; `symlink` is which links are
 * created on enable (each `source` a path inside the bundle). The legacy
 * single-array install format (one `{source,dest}` rule meaning both pack and
 * link) is NOT supported (pre-release breaking change, 2026-07): it is not
 * parsed into `bundle`/`symlink` at all, falls through to `extras` like any
 * unmodeled section, and publish preflight rejects a manifest whose extras
 * contain one (see publishChecks.ts).
 */
export interface ManifestModel {
  project: { name: string; version: string; author: string; description: string };
  bundle: { path: string }[];
  symlink: { source: string; dest: string }[];
  requires_module: { id: string }[];
  /** Executable entrypoints declared via `[[entrypoint]]` blocks. */
  entrypoint: ManifestEntrypoint[];
  /** Mission scripts declared via `[[mission_script]]` blocks. */
  mission_script: ManifestMissionScript[];
  extras: string[];
}

/** Result of packaging a release payload into one or more 7z volumes. */
export interface PackagedPayload {
  /** The archive volume file(s): one `<base>.7z`, or ordered `<base>.7z.NNN`. */
  volumes: string[];
  totalBytes: number;
  split: boolean;
}

/** A release asset advertised by the marketplace. */
export interface ProductAsset {
  name: string;
  size: number;
  url: string;
}

/** A marketplace listing (repo-level discovery result). */
export interface MarketListing {
  repo: string;
  name: string;
  author: string;
  description: string;
  labels: string[];
  repo_url: string;
  avatar_url: string;
  stars: number;
}

/** A marketplace product page (repo header + latest-release facts). */
export interface ProductDetail {
  repo: string;
  name: string;
  author: string;
  description: string;
  repo_url: string;
  avatar_url: string;
  stars: number;
  readme: string | null;
  release_tag: string | null;
  release_url: string | null;
  /**
   * ISO-8601 publish time of the latest release (GitHub's `published_at`), or
   * null when there is no release. A trust signal (last-release recency) — it
   * rides the same `releases/latest` payload, so surfacing it adds no API call.
   */
  release_date: string | null;
  assets: ProductAsset[];
  download_size: number;
  installable: boolean;
  installs: { source: string; dest: string }[];
  requires: { id: string; name: string; installed: boolean }[];
}

/** What an installer needs to download + unpack a specific release. */
export interface InstallTarget {
  repo: string;
  name: string;
  tag: string;
  assets: ProductAsset[];
}

/** A link the linker is asked to create. */
export interface LinkDefinition {
  id: string;
  /** Absolute source (the unpacked asset in the data dir). */
  src: string;
  /** Absolute destination (inside the DCS folders). */
  dest: string;
}

/** A link the linker successfully created. */
export interface ResolvedLink {
  id: string;
  src: string;
  dest: string;
}

/** A previously-created link identified for removal. */
export interface InstalledLink {
  id: string;
  installedPath: string;
}

/** Outcome of an `enable` — all-or-nothing with rollback on failure. */
export type LinkResult =
  | { ok: true; created: ResolvedLink[] }
  | { ok: false; message: string };

/** Outcome of a `disable` — each entry attempted independently. */
export interface DisableResult {
  removed: string[];
  failed: { id: string; message: string }[];
}
