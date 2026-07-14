import * as path from "path";
import { payloadBase } from "../domain/archivePolicy";
import { fmtBytes } from "../domain/format";
import { DISCOVERY_TOPIC } from "../domain/githubMarketplace";
import type { GhFacts } from "../domain/publishChecks";
import { gitignoreNeedsEntry, gitignoreWithEntry } from "../domain/publishPolicy";
import type { ManifestModel, PackagedPayload } from "../domain/types";
import type { ArchivePort } from "../ports/archive";
import type { FileSystemPort } from "../ports/filesystem";
import type { GhPort } from "../ports/gh";
import type { GitPort } from "../ports/git";
import type { ManifestPort } from "../ports/manifest";

// Publish orchestration, mirroring dcs-studio's Publisher, driven through ports:
// git (local), gh (repo + release), archive (payload). Share creates the GitHub
// repo and pushes; cutRelease packages the manifest + every [[bundle]] path into
// a 7z payload (volume-split when large), then creates a release with the
// standalone dcs-studio.toml sitting alongside every payload volume.

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
    if (create.alreadyExists) {
      log("Repo already exists — pushing to it.");
      await git.setRemote(root, "origin", `https://github.com/${owner}/${opts.name}.git`);
      await git.push(root, "origin", "HEAD:main");
    }

    const topics = [DISCOVERY_TOPIC];
    for (const t of topics) {
      log(`Tagging topic: ${t}`);
      await gh.repoTopicAdd(`${owner}/${opts.name}`, t);
    }
    return { owner, name: opts.name, url: `https://github.com/${owner}/${opts.name}` };
  }

  /** Package the payload (volume-split when large) and create a GitHub release with
   *  the standalone manifest alongside every payload volume. */
  async cutRelease(root: string, opts: ReleaseOpts, log: Log): Promise<ReleaseResult> {
    const { gh, archive, fs, manifest } = this.ports;
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
    log("Packaging payload with 7-Zip…");
    const packaged = await archive.packagePayload(
      root,
      files,
      outDir,
      payloadBase(opts.name, opts.tag),
      opts.volumeBytes,
    );
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

    // Idempotent re-publish: drop any prior release + tag for this tag first.
    await gh.releaseDelete(`${opts.owner}/${opts.name}`, opts.tag);

    log(`Creating release ${opts.tag} and uploading ${assets.length} assets…`);
    await gh.releaseCreate({
      repo: `${opts.owner}/${opts.name}`,
      tag: opts.tag,
      title: opts.tag,
      notes: opts.notes || `Release ${opts.tag}`,
      assets,
    });

    return {
      assets: assets.map((a) => path.basename(a)),
      url: `https://github.com/${opts.owner}/${opts.name}/releases/tag/${opts.tag}`,
      packaged,
    };
  }
}
