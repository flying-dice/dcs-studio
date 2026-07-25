import type {
  GhReleaseCreateOptions,
  GhReleaseEditOptions,
  GhRepoCreateOptions,
} from "../ports/gh";

// Argument vectors for the three external CLIs the adapters drive: `gh`, `git`
// and 7-Zip. These are pure string arrays with no spawning, so the flags that
// decide what happens to a user's repository or release are testable without
// running anything.
//
// This matters more here than the usual "extract for testability" argument.
// `gh release delete --cleanup-tag` removes a tag other people may already have
// fetched, `git push -u` sets an upstream, and 7-Zip's `-v<n>b` decides whether
// a release ships as one archive or a volume set that older clients cannot
// reassemble. A wrong flag in any of those is discovered by a user mid-publish,
// not by a developer — and none of it was covered while it lived inline in the
// adapters.
//
// The adapters keep only the spawn call and its error mapping.

/** Identity used for commits DCS Studio makes on the user's behalf. */
export const COMMIT_IDENTITY = {
  email: "noreply@dcs-studio",
  name: "DCS Studio",
} as const;

export const ghArgs = {
  /** Probe: is the CLI present at all? */
  version: (): string[] => ["--version"],
  /** Probe: is the CLI signed in? */
  authStatus: (): string[] => ["auth", "status"],
  /** The signed-in login, printed bare for parsing. */
  apiUser: (): string[] => ["api", "user", "-q", ".login"],
  repoCreate: (opts: GhRepoCreateOptions): string[] => {
    // Visibility defaults to public: a mod nobody can fetch cannot appear in
    // the marketplace, which is the point of publishing.
    const args = [
      "repo",
      "create",
      opts.name,
      `--${opts.visibility ?? "public"}`,
      "--source",
      opts.source,
    ];
    if (opts.remote) args.push("--remote", opts.remote);
    // Push unless explicitly disabled — `push: undefined` means "yes".
    if (opts.push !== false) args.push("--push");
    // Always pass -d, even empty: omitting it makes gh prompt interactively,
    // which would hang a spawn with no TTY.
    args.push("-d", opts.description ?? "");
    return args;
  },

  repoTopicAdd: (repo: string, topic: string): string[] => [
    "repo",
    "edit",
    repo,
    "--add-topic",
    topic,
  ],

  releaseView: (repo: string, tag: string): string[] => ["release", "view", tag, "-R", repo],

  /**
   * Delete a release AND its tag. `--cleanup-tag` is what makes the rollback of
   * a half-created release complete: without it the tag survives and the next
   * create collides with it. This is only ever aimed at a release this run just
   * created — an existing release is replaced in place, never deleted.
   */
  releaseDelete: (repo: string, tag: string): string[] => [
    "release",
    "delete",
    tag,
    "-R",
    repo,
    "--yes",
    "--cleanup-tag",
  ],

  releaseCreate: (opts: GhReleaseCreateOptions): string[] => [
    "release",
    "create",
    opts.tag,
    ...opts.assets,
    "-R",
    opts.repo,
    "--title",
    opts.title,
    "--notes",
    opts.notes,
  ],

  /**
   * Upload assets onto an *existing* release. `--clobber` is load-bearing:
   * without it gh refuses an asset whose name is already attached, so a
   * re-release could not replace its own payload without deleting it first.
   */
  releaseUpload: (repo: string, tag: string, assets: string[]): string[] => [
    "release",
    "upload",
    tag,
    ...assets,
    "-R",
    repo,
    "--clobber",
  ],

  /** Retitle/re-note an existing release, leaving its tag and assets alone. */
  releaseEdit: (opts: GhReleaseEditOptions): string[] => [
    "release",
    "edit",
    opts.tag,
    "-R",
    opts.repo,
    "--title",
    opts.title,
    "--notes",
    opts.notes,
  ],

  /** The asset file names attached to a release, one per line. */
  releaseAssetNames: (repo: string, tag: string): string[] => [
    "release",
    "view",
    tag,
    "-R",
    repo,
    "--json",
    "assets",
    "-q",
    ".assets[].name",
  ],

  /** Detach one asset from a release (the release and tag survive). */
  releaseAssetDelete: (repo: string, tag: string, name: string): string[] => [
    "release",
    "delete-asset",
    tag,
    name,
    "-R",
    repo,
    "--yes",
  ],
} as const;

export const gitArgs = {
  version: (): string[] => ["--version"],
  isRepo: (): string[] => ["rev-parse", "--is-inside-work-tree"],
  init: (): string[] => ["init"],
  /** Rename the freshly-initialised branch; DCS Studio publishes from `main`. */
  branchMain: (): string[] => ["branch", "-M", "main"],
  addAll: (): string[] => ["add", "-A"],
  status: (): string[] => ["status", "--porcelain"],

  /**
   * Commit with the extension's identity passed per-invocation via `-c`, so a
   * user with no configured git identity can still publish and their global
   * config is never written to.
   */
  commit: (message: string): string[] => [
    "-c",
    `user.email=${COMMIT_IDENTITY.email}`,
    "-c",
    `user.name=${COMMIT_IDENTITY.name}`,
    "commit",
    "-m",
    message,
  ],

  getRemoteUrl: (remote: string): string[] => ["remote", "get-url", remote],
  remoteAdd: (remote: string, url: string): string[] => ["remote", "add", remote, url],
  push: (remote: string, ref: string): string[] => ["push", "-u", remote, ref],
} as const;

export const sevenZipArgs = {
  /** Extract `archive` into `outDir`. `-o` takes no space before its value. */
  extract: (archive: string, outDir: string): string[] => ["x", "-y", `-o${outDir}`, archive],

  /**
   * Pack `files` into a single `.7z`. `-mx=5` is the normal compression level:
   * higher levels cost minutes on large mod payloads for a few percent.
   */
  pack: (archive: string, files: string[]): string[] => [
    "a",
    "-t7z",
    "-mx=5",
    "-y",
    archive,
    ...files,
  ],

  /**
   * Pack into numbered volumes of `limitBytes` each. The `b` suffix is
   * required — bare `-v1500000000` is read as bytes by some builds and as
   * blocks by others, and a wrong unit produces volumes GitHub rejects.
   */
  packSplit: (archive: string, files: string[], limitBytes: number): string[] => [
    "a",
    "-t7z",
    "-mx=5",
    "-y",
    `-v${limitBytes}b`,
    archive,
    ...files,
  ],
} as const;
