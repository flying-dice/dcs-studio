// Core-owned domain data types. These carry the shapes that ports exchange with
// the outside world. NOTHING here imports `vscode`, Node I/O, or `src/adapters`
// — they are plain data. Adapters map their native results into these types.

/** A single link a mod declares between an unpacked asset and a DCS destination. */
export interface ModLink {
  id: string;
  dest: string;
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
 * created on enable (each `source` a path inside the bundle). Legacy
 * `[[install]] {source,dest}` blocks are normalized at parse time into
 * `bundle {path:source}` + `symlink {source,dest}`, so nothing downstream sees
 * `install` — old published releases keep installing, new emission writes only
 * the split blocks.
 */
export interface ManifestModel {
  project: { name: string; version: string; author: string; description: string };
  bundle: { path: string }[];
  symlink: { source: string; dest: string }[];
  requires_module: { id: string }[];
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
