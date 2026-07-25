import { win32 as path } from "node:path";
import { payloadBase, stalePayloadVolumes } from "../domain/archivePolicy";
import { fmtBytes } from "../domain/format";
import { DISCOVERY_TOPIC } from "../domain/githubMarketplace";
import type { GhFacts } from "../domain/publishChecks";
import { gitignoreNeedsEntry, gitignoreWithEntry } from "../domain/publishPolicy";
import { parseRepoRemote, type RepoRef } from "../domain/repoRemote";
import type { ManifestModel, PackagedPayload } from "../domain/types";
import type { ArchivePort } from "../ports/archive";
import type { FileSystemPort } from "../ports/filesystem";
import type { GhPort, GhReleaseCreateOptions } from "../ports/gh";
import type { GitPort } from "../ports/git";
import type { ManifestPort } from "../ports/manifest";

// Publish orchestration, mirroring dcs-studio's Publisher, driven through ports:
// git (local), gh (repo + release), archive (payload). Share creates the GitHub
// repo and pushes; cutRelease packages the manifest + every [[bundle]] path into
// a 7z payload (volume-split when large), then publishes a release with the
// standalone dcs-studio.toml sitting alongside every payload volume.
//
// The ordering rules in cutRelease are the point of this file. Nothing a user
// already has may be removed before its replacement is in place: a release that
// exists is overwritten asset-by-asset, and only a release this run created
// itself is ever deleted (to undo a create that died half-way).

/** Streaming progress callback — one human-readable line per step. */
export type Log = (line: string) => void;

export interface ShareOpts {
  name: string;
  description: string;
}
export interface ShareResult {
  owner: string;
  name: string;
  url: string;
}

export interface ReleaseOpts {
  owner: string;
  name: string;
  tag: string;
  notes: string;
  volumeBytes?: number;
}
export interface ReleaseResult {
  assets: string[];
  url: string;
  packaged: PackagedPayload;
}

/** The ports the publish flows need from the outside world. */
export interface PublishPorts {
  git: GitPort;
  gh: GhPort;
  archive: ArchivePort;
  fs: FileSystemPort;
  manifest: ManifestPort;
}

/** Tool-availability facts the publish preflight panel renders, gathered
 *  through the injected ports so the panel depends on this service (not the
 *  concrete node adapters). */
export interface PublishToolFacts {
  /** The resolved 7-Zip command/path, or null when unavailable. */
  sevenZip: string | null;
  /** Whether git is available on PATH. */
  gitAvailable: boolean;
  /** gh CLI presence + auth. */
  gh: GhFacts;
}

export class PublishService {
  constructor(private readonly ports: PublishPorts) {}

  /** Gather the preflight tool facts (7-Zip, git, gh presence/auth) via the
   *  ports, so the Publish panel reaches them through this service. */
  async toolFacts(): Promise<PublishToolFacts> {
    const { archive, git, gh } = this.ports;
    const [sevenZip, gitAvailable, present, authed] = await Promise.all([
      archive.available(),
      git.isInstalled(),
      gh.isInstalled(),
      gh.isAuthed(),
    ]);
    return { sevenZip, gitAvailable, gh: { present, authed } };
  }

  /** The URL of `root`'s `remote` (default `origin`), or null — routed through
   *  the git port for the panel's repo detection. */
  remoteUrl(root: string, remote = "origin"): Promise<string | null> {
    return this.ports.git.getRemoteUrl(root, remote);
  }

  /** Guarantee `.gitignore` hides the `.dcs-studio/` working dir before committing. */
  private async ensureGitignore(root: string): Promise<void> {
    const { fs } = this.ports;
    const p = path.join(root, ".gitignore");
    let text = "";
    try {
      text = await fs.readText(p);
    } catch {
      /* none yet */
    }
    if (gitignoreNeedsEntry(text)) {
      await fs.writeText(p, gitignoreWithEntry(text));
    }
  }

  /**
   * The repository `gh` actually created, read back from the `origin` remote it
   * wired up. GitHub rewrites names it will not take verbatim — the prefilled
   * `[project] name` of a scaffolded mod is a human-readable "My Mod", which
   * lands as "My-Mod" — so the requested name is a guess and the remote is the
   * only authoritative answer. Falls back to the guess when there is no usable
   * remote to read.
   */
  private async createdRepo(root: string, fallback: RepoRef): Promise<RepoRef> {
    const url = await this.ports.git.getRemoteUrl(root, "origin");
    return (url && parseRepoRemote(url)) || fallback;
  }

  /** Create (or reuse) the GitHub repo, push, and tag its discovery topics. */
  async share(root: string, opts: ShareOpts, log: Log): Promise<ShareResult> {
    const { git, gh } = this.ports;
    const owner = await gh.login();
    if (!owner) throw new Error("Not signed in to gh — run `gh auth login`.");

    if (!(await git.isRepo(root))) {
      log("git init");
      await git.init(root);
    }
    await this.ensureGitignore(root);
    await git.addAll(root);
    if (await git.hasChanges(root)) {
      log("git commit");
      await git.commit(root, "Publish with DCS Studio");
    }

    log(`Creating GitHub repo ${owner}/${opts.name}…`);
    const create = await gh.repoCreate({
      name: opts.name,
      description: opts.description || "",
      visibility: "public",
      source: root,
      remote: "origin",
      push: true,
    });
    const requested: RepoRef = { owner, name: opts.name };
    let ref = requested;
    if (create.alreadyExists) {
      log("Repo already exists — pushing to it.");
      await git.setRemote(root, "origin", `https://github.com/${owner}/${opts.name}.git`);
      await git.push(root, "origin", "HEAD:main");
    } else {
      ref = await this.createdRepo(root, requested);
      if (ref.name !== requested.name || ref.owner !== requested.owner)
        log(`GitHub named it ${ref.owner}/${ref.name}.`);
    }
    const repo = `${ref.owner}/${ref.name}`;

    const topics = [DISCOVERY_TOPIC];
    for (const t of topics) {
      // Logged after the attempt: the topic is what Marketplace discovery
      // searches on, so a share that reports success while the tagging failed
      // leaves a mod nobody can find and nothing said so.
      const tagged = await gh.repoTopicAdd(repo, t);
      log(
        tagged
          ? `Tagged topic: ${t}`
          : `⚠ Could not tag topic ${t} — the mod stays invisible to Marketplace discovery until it is tagged.`,
      );
    }
    return { owner: ref.owner, name: ref.name, url: `https://github.com/${repo}` };
  }

  /** Package the payload (volume-split when large) and publish it as a GitHub
   *  release with the standalone manifest alongside every payload volume —
   *  replacing an existing release for the tag in place rather than deleting it. */
  async cutRelease(root: string, opts: ReleaseOpts, log: Log): Promise<ReleaseResult> {
    const { gh, archive, fs, manifest } = this.ports;
    const tag = opts.tag.trim();
    // Guarded here and not only in the panel: an empty tag packages under a
    // base name ending in a bare hyphen and then fails at the CLI, after the
    // work is done.
    if (!tag) throw new Error("A release tag is required (e.g. v1.0.0).");
    let m: ManifestModel;
    try {
      m = manifest.parseToml(await fs.readText(path.join(root, "dcs-studio.toml")));
    } catch {
      throw new Error("Cannot read dcs-studio.toml.");
    }
    if (!(await archive.available())) throw new Error("7z not found.");

    const files = ["dcs-studio.toml"];
    const seen = new Set<string>();
    for (const b of m.bundle) {
      if (seen.has(b.path)) continue; // dedupe: one archive entry per path
      seen.add(b.path);
      const abs = path.join(root, b.path);
      if (!(await fs.exists(abs)))
        throw new Error(`Bundle path missing: ${b.path} — build the project first.`);
      files.push(b.path);
    }

    const outDir = path.join(root, ".dcs-studio", "release");
    const base = payloadBase(opts.name, tag);
    log("Packaging payload with 7-Zip…");
    const packaged = await archive.packagePayload(root, files, outDir, base, opts.volumeBytes);
    log(
      packaged.split
        ? `Split into ${packaged.volumes.length} volumes (${fmtBytes(packaged.totalBytes)} total).`
        : `Packaged a single archive (${fmtBytes(packaged.totalBytes)}).`,
    );

    // The standalone manifest sits next to the release so the Marketplace reads the
    // install plan without downloading the payload.
    const manifestAsset = path.join(outDir, "dcs-studio.toml");
    await fs.copy(path.join(root, "dcs-studio.toml"), manifestAsset);
    const assets = [manifestAsset, ...packaged.volumes];
    const repo = `${opts.owner}/${opts.name}`;
    const notes = opts.notes || `Release ${tag}`;

    // Publishing is the least reversible thing this product does, so the two
    // cases are kept apart rather than collapsed into "delete, then create":
    // an existing release is REPLACED IN PLACE (upload over it, retitle, then
    // prune what the old payload left behind), so there is no moment where the
    // repository has no release and no tag for this version. A first release
    // has nothing to protect, so it is created outright — and if that create
    // dies mid-upload, the partial release and its tag are rolled back to the
    // state the repository was in before.
    if (await gh.releaseView(repo, tag)) {
      log(`Release ${tag} already exists — uploading ${assets.length} assets over it…`);
      await gh.releaseUpload(repo, tag, assets);
      await gh.releaseEdit({ repo, tag, title: tag, notes });
      await this.pruneStaleVolumes(repo, tag, base, assets, log);
      log(`Replaced release ${tag} in place — the tag was never removed.`);
    } else {
      log(`Creating release ${tag} and uploading ${assets.length} assets…`);
      await this.createOrRollBack({ repo, tag, title: tag, notes, assets }, log);
    }

    return {
      assets: assets.map((a) => path.basename(a)),
      url: `https://github.com/${repo}/releases/tag/${tag}`,
      packaged,
    };
  }

  /** Drop volumes of the previous payload that this run did not overwrite — a
   *  stale `.7z.003` left riding along would corrupt the volume set. Runs only
   *  after the replacement assets are up. */
  private async pruneStaleVolumes(
    repo: string,
    tag: string,
    base: string,
    assets: string[],
    log: Log,
  ): Promise<void> {
    const attached = await this.ports.gh.releaseAssetNames(repo, tag);
    const stale = stalePayloadVolumes(
      attached,
      base,
      assets.map((a) => path.basename(a)),
    );
    for (const name of stale) {
      const removed = await this.ports.gh.releaseAssetDelete(repo, tag, name);
      log(
        removed
          ? `Removed stale asset ${name}.`
          : `⚠ Could not remove stale asset ${name} — delete it by hand before anyone installs.`,
      );
    }
  }

  /** Create a release that did not exist before, undoing a half-finished one.
   *  Because nothing existed for this tag, deleting the remains restores the
   *  repository rather than destroying anything. */
  private async createOrRollBack(opts: GhReleaseCreateOptions, log: Log): Promise<void> {
    try {
      await this.ports.gh.releaseCreate(opts);
    } catch (e) {
      log(`Release ${opts.tag} failed — removing the half-created release and tag.`);
      await this.ports.gh.releaseDelete(opts.repo, opts.tag);
      throw e;
    }
  }
}
