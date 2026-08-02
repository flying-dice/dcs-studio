import { win32 as path } from "node:path";
import { describe, expect, it } from "vitest";
import { type PublishPorts, PublishService } from "../../../src/core/app/publishService";
import { DEFAULT_VOLUME_BYTES } from "../../../src/core/domain/archivePolicy";
import type { InstallRoots, ManifestModel, PackagedPayload } from "../../../src/core/domain/types";
import type { ArchivePort } from "../../../src/core/ports/archive";
import type {
  GhPort,
  GhReleaseCreateOptions,
  GhReleaseEditOptions,
  GhRepoCreateOptions,
  GhRepoCreateResult,
} from "../../../src/core/ports/gh";
import type { GitPort } from "../../../src/core/ports/git";
import type { ManifestPort } from "../../../src/core/ports/manifest";
import { MemFileSystem } from "../../support/memFileSystem";
import { RecordingFileSystem } from "../../support/recordingFileSystem";

// ── Recording fakes ──────────────────────────────────────────────────────────

class FakeGit implements GitPort {
  calls: unknown[][] = [];
  repo = true;
  changes = true;
  async isInstalled(): Promise<boolean> {
    this.calls.push(["isInstalled"]);
    return true;
  }
  async isRepo(root: string): Promise<boolean> {
    this.calls.push(["isRepo", root]);
    return this.repo;
  }
  async init(root: string): Promise<void> {
    this.calls.push(["init", root]);
  }
  async addAll(root: string): Promise<void> {
    this.calls.push(["addAll", root]);
  }
  async hasChanges(root: string): Promise<boolean> {
    this.calls.push(["hasChanges", root]);
    return this.changes;
  }
  async commit(root: string, message: string): Promise<void> {
    this.calls.push(["commit", root, message]);
  }
  remoteUrlValue: string | null = null;
  async getRemoteUrl(root: string, remote?: string): Promise<string | null> {
    this.calls.push(["getRemoteUrl", root, remote]);
    return this.remoteUrlValue;
  }
  async setRemote(root: string, remote: string, url: string): Promise<void> {
    this.calls.push(["setRemote", root, remote, url]);
  }
  async push(root: string, remote: string, ref: string): Promise<void> {
    this.calls.push(["push", root, remote, ref]);
  }
}

class FakeGh implements GhPort {
  calls: unknown[][] = [];
  loginValue: string | null = "octocat";
  repoCreateResult: GhRepoCreateResult = { created: true, alreadyExists: false };
  topicAddOk = true;
  releaseExists = false;
  attachedAssets: string[] = [];
  assetDeleteOk = true;
  async facts(): Promise<{ present: boolean; authed: boolean }> {
    this.calls.push(["facts"]);
    return { present: true, authed: true };
  }
  async login(): Promise<string | null> {
    this.calls.push(["login"]);
    return this.loginValue;
  }
  async repoCreate(opts: GhRepoCreateOptions): Promise<GhRepoCreateResult> {
    this.calls.push(["repoCreate", opts]);
    return this.repoCreateResult;
  }
  async repoTopicAdd(repo: string, topic: string): Promise<boolean> {
    this.calls.push(["repoTopicAdd", repo, topic]);
    return this.topicAddOk;
  }
  async releaseView(repo: string, tag: string): Promise<boolean> {
    this.calls.push(["releaseView", repo, tag]);
    return this.releaseExists;
  }
  async releaseDelete(repo: string, tag: string): Promise<void> {
    this.calls.push(["releaseDelete", repo, tag]);
  }
  async releaseCreate(opts: GhReleaseCreateOptions): Promise<void> {
    this.calls.push(["releaseCreate", opts]);
  }
  async releaseUpload(repo: string, tag: string, assets: string[]): Promise<void> {
    this.calls.push(["releaseUpload", repo, tag, assets]);
  }
  async releaseEdit(opts: GhReleaseEditOptions): Promise<void> {
    this.calls.push(["releaseEdit", opts]);
  }
  async releaseAssetNames(repo: string, tag: string): Promise<string[]> {
    this.calls.push(["releaseAssetNames", repo, tag]);
    return this.attachedAssets;
  }
  async releaseAssetDelete(repo: string, tag: string, name: string): Promise<boolean> {
    this.calls.push(["releaseAssetDelete", repo, tag, name]);
    return this.assetDeleteOk;
  }
}

class FakeArchive implements ArchivePort {
  calls: unknown[][] = [];
  availableValue: string | null = "7z";
  packaged: PackagedPayload = { volumes: [], totalBytes: 0, split: false };
  async available(): Promise<string | null> {
    this.calls.push(["available"]);
    return this.availableValue;
  }
  async extract(archive: string, outDir: string): Promise<void> {
    this.calls.push(["extract", archive, outDir]);
  }
  async packagePayload(
    root: string,
    files: string[],
    outDir: string,
    base: string,
    volumeBytes?: number,
  ): Promise<PackagedPayload> {
    this.calls.push(["packagePayload", root, files, outDir, base, volumeBytes]);
    return this.packaged;
  }
}

class FakeManifest implements ManifestPort {
  calls: unknown[][] = [];
  model: ManifestModel | null = null;
  parseToml(text: string): ManifestModel {
    this.calls.push(["parseToml", text]);
    if (!this.model) throw new Error("bad toml");
    return this.model;
  }
  emitToml(model: ManifestModel): string {
    this.calls.push(["emitToml", model]);
    return "";
  }
  resolveDest(dest: string, roots: InstallRoots): string | null {
    this.calls.push(["resolveDest", dest, roots]);
    return null;
  }
}

function model(bundle: { path: string }[] = []): ManifestModel {
  return {
    project: { name: "My Mod", version: "1.0.0", author: "me", description: "d" },
    bundle,
    symlink: [],
    requires_module: [],
    entrypoint: [],
    mission_script: [],
    extras: [],
  };
}

interface Rig {
  git: FakeGit;
  gh: FakeGh;
  archive: FakeArchive;
  fs: RecordingFileSystem;
  mem: MemFileSystem;
  manifest: FakeManifest;
  service: PublishService;
  logs: string[];
  log: (line: string) => void;
}

function rig(): Rig {
  const git = new FakeGit();
  const gh = new FakeGh();
  const archive = new FakeArchive();
  const mem = new MemFileSystem();
  const fs = new RecordingFileSystem(mem);
  const manifest = new FakeManifest();
  const ports: PublishPorts = { git, gh, archive, fs, manifest };
  const logs: string[] = [];
  return {
    git,
    gh,
    archive,
    fs,
    mem,
    manifest,
    service: new PublishService(ports),
    logs,
    log: (l) => logs.push(l),
  };
}

const ROOT = path.join("C:", "work", "mod");
const gitignorePath = path.join(ROOT, ".gitignore");

// ── share ────────────────────────────────────────────────────────────────────

describe("PublishService.share", () => {
  it("rejects when gh is not signed in, before touching git", async () => {
    const r = rig();
    r.gh.loginValue = null;
    await expect(r.service.share(ROOT, { name: "mod", description: "" }, r.log)).rejects.toThrow(
      "Not signed in to gh — run `gh auth login`.",
    );
    expect(r.git.calls).toEqual([]);
  });

  it("fresh folder: inits the repo, writes .gitignore, commits, creates + tags the repo", async () => {
    const r = rig();
    r.git.repo = false;
    r.git.remoteUrlValue = "https://github.com/octocat/my-mod.git";
    const res = await r.service.share(ROOT, { name: "my-mod", description: "A mod" }, r.log);

    expect(r.git.calls).toEqual([
      ["isRepo", ROOT],
      ["init", ROOT],
      ["addAll", ROOT],
      ["hasChanges", ROOT],
      ["commit", ROOT, "Publish with DCS Studio"],
      // gh wired origin as part of the create; that remote is what says which
      // repository now exists.
      ["getRemoteUrl", ROOT, "origin"],
    ]);
    expect(r.mem.read(gitignorePath)).toBe(".dcs-studio/\n");
    expect(r.gh.calls).toEqual([
      ["login"],
      [
        "repoCreate",
        {
          name: "my-mod",
          description: "A mod",
          visibility: "public",
          source: ROOT,
          remote: "origin",
          push: true,
        },
      ],
      ["repoTopicAdd", "octocat/my-mod", "dcs-studio"],
    ]);
    expect(res).toEqual({
      owner: "octocat",
      name: "my-mod",
      url: "https://github.com/octocat/my-mod",
    });
    expect(r.logs).toEqual([
      "git init",
      "git commit",
      "Creating GitHub repo octocat/my-mod…",
      "Tagged topic: dcs-studio",
    ]);
  });

  it("existing repo with a clean tree: skips init and commit", async () => {
    const r = rig();
    r.git.changes = false;
    r.git.remoteUrlValue = "https://github.com/octocat/mod.git";
    r.mem.seedFile(gitignorePath, "out/\n.dcs-studio/\n");
    await r.service.share(ROOT, { name: "mod", description: "" }, r.log);

    expect(r.git.calls).toEqual([
      ["isRepo", ROOT],
      ["addAll", ROOT],
      ["hasChanges", ROOT],
      ["getRemoteUrl", ROOT, "origin"],
    ]);
    // .gitignore already carried the entry — nothing rewritten.
    expect(r.fs.calls.filter((c) => c[0] === "writeText")).toEqual([]);
    expect(r.logs).toEqual(["Creating GitHub repo octocat/mod…", "Tagged topic: dcs-studio"]);
  });

  it("appends the ignore entry to an existing .gitignore missing a trailing newline", async () => {
    const r = rig();
    r.mem.seedFile(gitignorePath, "out/");
    await r.service.share(ROOT, { name: "mod", description: "" }, r.log);
    expect(r.mem.read(gitignorePath)).toBe("out/\n.dcs-studio/\n");
  });

  it("repo already exists on GitHub: wires the remote and pushes instead", async () => {
    const r = rig();
    r.gh.repoCreateResult = { created: false, alreadyExists: true };
    const res = await r.service.share(ROOT, { name: "mod", description: "" }, r.log);

    expect(r.git.calls).toEqual(
      expect.arrayContaining([
        ["setRemote", ROOT, "origin", "https://github.com/octocat/mod.git"],
        ["push", ROOT, "origin", "HEAD:main"],
      ]),
    );
    expect(r.logs).toContain("Repo already exists — pushing to it.");
    expect(res.url).toBe("https://github.com/octocat/mod");
  });

  it("propagates a non-already-exists repo-create failure", async () => {
    const r = rig();
    r.gh.repoCreate = async () => {
      throw new Error("gh repo create: boom");
    };
    await expect(r.service.share(ROOT, { name: "mod", description: "" }, r.log)).rejects.toThrow(
      "gh repo create: boom",
    );
  });

  it("reports the repo GitHub actually created, not the name that was asked for", async () => {
    // The Repository field is prefilled from the human-readable [project] name,
    // so "My Mod" is the common input. GitHub takes the create and stores it as
    // "My-Mod"; reporting "octocat/My Mod" would give the user a dead link, a
    // release prefill that addresses nothing, and a topic tagged on nothing.
    const r = rig();
    r.git.remoteUrlValue = "https://github.com/octocat/My-Mod.git";
    const res = await r.service.share(ROOT, { name: "My Mod", description: "" }, r.log);

    expect(res).toEqual({
      owner: "octocat",
      name: "My-Mod",
      url: "https://github.com/octocat/My-Mod",
    });
    expect(r.gh.calls).toContainEqual(["repoTopicAdd", "octocat/My-Mod", "dcs-studio"]);
    expect(r.logs).toContain("GitHub named it octocat/My-Mod.");
  });

  it("takes the owner from the remote too, so an org create is reported correctly", async () => {
    const r = rig();
    r.git.remoteUrlValue = "git@github.com:flying-dice/mod.git";
    const res = await r.service.share(ROOT, { name: "mod", description: "" }, r.log);
    expect(res.owner).toBe("flying-dice");
    expect(r.logs).toContain("GitHub named it flying-dice/mod.");
  });

  it("falls back to the requested name when the remote says nothing usable", async () => {
    // No remote at all, or one that is not a GitHub URL: the requested name is
    // the only answer left, and it is better than reporting nothing.
    const r = rig();
    r.git.remoteUrlValue = null;
    expect((await r.service.share(ROOT, { name: "mod", description: "" }, r.log)).name).toBe("mod");

    const other = rig();
    other.git.remoteUrlValue = "https://gitlab.com/octocat/mod.git";
    const res = await other.service.share(ROOT, { name: "mod", description: "" }, other.log);
    expect(res).toEqual({ owner: "octocat", name: "mod", url: "https://github.com/octocat/mod" });
    expect(other.logs).not.toContain("GitHub named it octocat/mod.");
  });

  it("says so when the discovery topic could not be applied", async () => {
    // Logged after the attempt, not before: the topic is exactly what
    // Marketplace discovery searches on, so a share that claims success while
    // the tagging failed leaves a mod nobody can find.
    const r = rig();
    r.git.remoteUrlValue = "https://github.com/octocat/mod.git";
    r.gh.topicAddOk = false;
    await r.service.share(ROOT, { name: "mod", description: "" }, r.log);
    expect(r.logs).toContain(
      "⚠ Could not tag topic dcs-studio — the mod stays invisible to Marketplace discovery until it is tagged.",
    );
    expect(r.logs).not.toContain("Tagged topic: dcs-studio");
  });
});

// ── cutRelease ───────────────────────────────────────────────────────────────

const manifestPath = path.join(ROOT, "dcs-studio.toml");
const outDir = path.join(ROOT, ".dcs-studio", "release");
const manifestAsset = path.join(outDir, "dcs-studio.toml");
const releaseOpts = { owner: "octocat", name: "mod", tag: "v1.0.0", notes: "" };

/** A rig whose manifest + files are set up for a successful release. */
function releaseRig(bundle: { path: string }[] = []) {
  const r = rig();
  r.mem.seedFile(manifestPath, "[project]");
  r.manifest.model = model(bundle);
  // A built bundle path is a directory, and the check is `exists`, not a read —
  // the fake this replaced answered false for directories, so seeding files was
  // the only way to make the check pass at all.
  for (const b of bundle) r.mem.seedDir(path.join(ROOT, b.path));
  r.archive.packaged = {
    volumes: [path.join(outDir, "dcs-studio-mod-v1.0.0.7z")],
    totalBytes: 2048,
    split: false,
  };
  return r;
}

describe("PublishService.cutRelease", () => {
  it("rejects when the manifest cannot be read", async () => {
    const r = rig();
    await expect(r.service.cutRelease(ROOT, releaseOpts, r.log)).rejects.toThrow(
      "Cannot read dcs-studio.toml.",
    );
  });

  it("rejects when the manifest does not parse", async () => {
    const r = rig();
    r.mem.seedFile(manifestPath, "not toml");
    r.manifest.model = null; // parseToml throws
    await expect(r.service.cutRelease(ROOT, releaseOpts, r.log)).rejects.toThrow(
      "Cannot read dcs-studio.toml.",
    );
  });

  it("rejects when no archiver is available", async () => {
    const r = releaseRig();
    r.archive.availableValue = null;
    await expect(r.service.cutRelease(ROOT, releaseOpts, r.log)).rejects.toThrow("7z not found.");
  });

  it("rejects when a bundle path has not been built", async () => {
    const r = releaseRig([{ path: "out/built" }]);
    r.manifest.model = model([{ path: "out/built" }, { path: "out/missing" }]);
    await expect(r.service.cutRelease(ROOT, releaseOpts, r.log)).rejects.toThrow(
      "Bundle path missing: out/missing — build the project first.",
    );
    expect(r.archive.calls.filter((c) => c[0] === "packagePayload")).toEqual([]);
  });

  it("dedupes repeated bundle paths in the archive file list", async () => {
    const r = releaseRig([{ path: "out/mod" }]);
    // A model carrying the same path twice must produce one archive entry.
    r.manifest.model = model([{ path: "out/mod" }, { path: "out/mod" }]);
    await r.service.cutRelease(ROOT, releaseOpts, r.log);
    const pack = r.archive.calls.find((c) => c[0] === "packagePayload");
    expect(pack?.[2]).toEqual(["dcs-studio.toml", "out/mod"]);
  });

  it("small payload: packages a single volume and releases manifest + volume", async () => {
    const r = releaseRig([{ path: "out/mod" }]);
    const res = await r.service.cutRelease(ROOT, { ...releaseOpts, notes: "hello" }, r.log);

    expect(r.archive.calls).toEqual([
      ["available"],
      [
        "packagePayload",
        ROOT,
        ["dcs-studio.toml", "out/mod"],
        outDir,
        "dcs-studio-mod-v1.0.0",
        undefined,
      ],
    ]);
    // The standalone manifest is copied alongside the payload.
    expect(r.fs.calls).toContainEqual(["copy", manifestPath, manifestAsset]);
    // Nothing exists for this tag, so nothing is deleted — the release is
    // created outright.
    expect(r.gh.calls).toEqual([
      ["releaseView", "octocat/mod", "v1.0.0"],
      [
        "releaseCreate",
        {
          repo: "octocat/mod",
          tag: "v1.0.0",
          title: "v1.0.0",
          notes: "hello",
          assets: [manifestAsset, path.join(outDir, "dcs-studio-mod-v1.0.0.7z")],
        },
      ],
    ]);
    expect(res).toEqual({
      assets: ["dcs-studio.toml", "dcs-studio-mod-v1.0.0.7z"],
      url: "https://github.com/octocat/mod/releases/tag/v1.0.0",
      packaged: r.archive.packaged,
    });
    expect(r.logs).toEqual([
      "Packaging payload with 7-Zip…",
      "Packaged a single archive (2.0 KB).",
      "Creating release v1.0.0 and uploading 2 assets…",
    ]);
  });

  it("oversized payload: splits into volumes via the archive policy and uploads them all", async () => {
    const r = releaseRig([{ path: "out/mod" }]);
    r.archive.packaged = {
      volumes: [path.join(outDir, "a.7z.001"), path.join(outDir, "a.7z.002")],
      totalBytes: 3 * 1024 * 1024 * 1024,
      split: true,
    };
    const res = await r.service.cutRelease(ROOT, { ...releaseOpts, volumeBytes: 1024 }, r.log);

    // The requested split size flows through to the archiver.
    expect(r.archive.calls).toContainEqual([
      "packagePayload",
      ROOT,
      ["dcs-studio.toml", "out/mod"],
      outDir,
      "dcs-studio-mod-v1.0.0",
      1024,
    ]);
    expect(res.assets).toEqual(["dcs-studio.toml", "a.7z.001", "a.7z.002"]);
    expect(r.logs).toContain("Split into 2 volumes (3.0 GB total).");
    expect(r.logs).toContain("Creating release v1.0.0 and uploading 3 assets…");
  });

  it("defaults empty notes to `Release <tag>`", async () => {
    const r = releaseRig();
    await r.service.cutRelease(ROOT, releaseOpts, r.log);
    const create = r.gh.calls.find((c) => c[0] === "releaseCreate");
    expect((create?.[1] as { notes: string } | undefined)?.notes).toBe("Release v1.0.0");
  });

  it("a first release for a tag deletes nothing at all", async () => {
    const r = releaseRig();
    await r.service.cutRelease(ROOT, releaseOpts, r.log);
    expect(r.gh.calls.map((c) => c[0])).not.toContain("releaseDelete");
  });

  it("ships only the manifest when there are no bundle paths", async () => {
    const r = releaseRig();
    await r.service.cutRelease(ROOT, releaseOpts, r.log);
    const pack = r.archive.calls.find((c) => c[0] === "packagePayload");
    expect(pack?.[2]).toEqual(["dcs-studio.toml"]);
  });

  it("uses the default volume size when none is requested", async () => {
    const r = releaseRig();
    await r.service.cutRelease(ROOT, releaseOpts, r.log);
    const pack = r.archive.calls.find((c) => c[0] === "packagePayload");
    expect(pack?.[5]).toBeUndefined();
    expect(DEFAULT_VOLUME_BYTES).toBeGreaterThan(0); // policy default lives with the archiver
  });

  it("refuses an empty tag before packaging anything", async () => {
    // An empty tag used to package under a base name ending in a bare hyphen
    // and only fail at the CLI, with the destructive part already done.
    const r = releaseRig();
    await expect(r.service.cutRelease(ROOT, { ...releaseOpts, tag: "   " }, r.log)).rejects.toThrow(
      "A release tag is required (e.g. v1.0.0).",
    );
    expect(r.archive.calls).toEqual([]);
    expect(r.gh.calls).toEqual([]);
  });

  it("trims the tag it packages, releases and links against", async () => {
    const r = releaseRig();
    const res = await r.service.cutRelease(ROOT, { ...releaseOpts, tag: " v1.0.0 " }, r.log);
    expect(r.archive.calls.find((c) => c[0] === "packagePayload")?.[4]).toBe(
      "dcs-studio-mod-v1.0.0",
    );
    expect(r.gh.calls).toContainEqual(["releaseView", "octocat/mod", "v1.0.0"]);
    expect(res.url).toBe("https://github.com/octocat/mod/releases/tag/v1.0.0");
  });
});

// ── cutRelease: replacing a release that already exists ───────────────────────

describe("PublishService.cutRelease — re-releasing an existing tag", () => {
  it("replaces the release in place instead of deleting it first", async () => {
    // The whole point. A delete-then-create leaves the repository with no
    // release and no tag for the length of the upload, and an upload that dies
    // half-way through a multi-volume payload leaves it that way for good.
    const r = releaseRig();
    r.gh.releaseExists = true;
    r.gh.attachedAssets = ["dcs-studio.toml", "dcs-studio-mod-v1.0.0.7z"];
    await r.service.cutRelease(ROOT, { ...releaseOpts, notes: "again" }, r.log);

    const volume = path.join(outDir, "dcs-studio-mod-v1.0.0.7z");
    expect(r.gh.calls).toEqual([
      ["releaseView", "octocat/mod", "v1.0.0"],
      ["releaseUpload", "octocat/mod", "v1.0.0", [manifestAsset, volume]],
      ["releaseEdit", { repo: "octocat/mod", tag: "v1.0.0", title: "v1.0.0", notes: "again" }],
      ["releaseAssetNames", "octocat/mod", "v1.0.0"],
    ]);
    expect(r.gh.calls.map((c) => c[0])).not.toContain("releaseDelete");
    expect(r.logs).toContain("Release v1.0.0 already exists — uploading 2 assets over it…");
    expect(r.logs).toContain("Replaced release v1.0.0 in place — the tag was never removed.");
  });

  it("prunes volumes the previous, larger payload left attached", async () => {
    // Two volumes replacing three: the stale .003 would otherwise ride along
    // and 7-Zip would reassemble a payload that never existed.
    const r = releaseRig();
    r.gh.releaseExists = true;
    r.archive.packaged = {
      volumes: [
        path.join(outDir, "dcs-studio-mod-v1.0.0.7z.001"),
        path.join(outDir, "dcs-studio-mod-v1.0.0.7z.002"),
      ],
      totalBytes: 4096,
      split: true,
    };
    r.gh.attachedAssets = [
      "dcs-studio.toml",
      "dcs-studio-mod-v1.0.0.7z.001",
      "dcs-studio-mod-v1.0.0.7z.002",
      "dcs-studio-mod-v1.0.0.7z.003",
      "screenshot.png",
    ];
    await r.service.cutRelease(ROOT, releaseOpts, r.log);

    // Only the stale volume — the author's own screenshot is not ours to drop,
    // and pruning runs after the replacement assets are already up.
    expect(r.gh.calls.filter((c) => c[0] === "releaseAssetDelete")).toEqual([
      ["releaseAssetDelete", "octocat/mod", "v1.0.0", "dcs-studio-mod-v1.0.0.7z.003"],
    ]);
    expect(r.logs).toContain("Removed stale asset dcs-studio-mod-v1.0.0.7z.003.");
  });

  it("names a stale asset it could not remove rather than staying quiet", async () => {
    const r = releaseRig();
    r.gh.releaseExists = true;
    r.gh.assetDeleteOk = false;
    r.gh.attachedAssets = ["dcs-studio-mod-v1.0.0.7z.001"];
    await r.service.cutRelease(ROOT, releaseOpts, r.log);
    expect(r.logs).toContain(
      "⚠ Could not remove stale asset dcs-studio-mod-v1.0.0.7z.001 — delete it by hand before anyone installs.",
    );
  });

  it("leaves the existing release standing when the replacement upload fails", async () => {
    const r = releaseRig();
    r.gh.releaseExists = true;
    r.gh.releaseUpload = async () => {
      throw new Error("gh release upload: connection reset");
    };
    await expect(r.service.cutRelease(ROOT, releaseOpts, r.log)).rejects.toThrow(
      "connection reset",
    );
    // Nothing was deleted on the way in, so the previous release and its tag
    // are exactly where they were.
    expect(r.gh.calls.map((c) => c[0])).not.toContain("releaseDelete");
  });

  it("rolls back a first release whose create died mid-upload", async () => {
    // Nothing existed for this tag beforehand, so removing the half-created
    // release and its tag restores the repository rather than destroying
    // anything — and leaves the retry a clean tag to create.
    const r = releaseRig();
    r.gh.releaseCreate = async () => {
      throw new Error("gh release create: HTTP 502");
    };
    await expect(r.service.cutRelease(ROOT, releaseOpts, r.log)).rejects.toThrow("HTTP 502");
    expect(r.gh.calls.at(-1)).toEqual(["releaseDelete", "octocat/mod", "v1.0.0"]);
    expect(r.logs).toContain("Release v1.0.0 failed — removing the half-created release and tag.");
  });
});

// ── toolFacts / remoteUrl (preflight facts routed through the service) ─────────

describe("PublishService.toolFacts", () => {
  it("gathers 7-Zip, git and gh presence/auth through the ports", async () => {
    const r = rig();
    r.archive.availableValue = "C:/7z/7z.exe";
    const facts = await r.service.toolFacts();
    expect(facts).toEqual({
      sevenZip: "C:/7z/7z.exe",
      gitAvailable: true,
      gh: { present: true, authed: true },
    });
    expect(r.archive.calls).toContainEqual(["available"]);
    expect(r.git.calls).toContainEqual(["isInstalled"]);
    // ONE gh probe pass per toolFacts call: presence and auth arrive together,
    // because separate calls each re-ran the cold, network-bound gh CLI.
    expect(r.gh.calls).toEqual([["facts"]]);
  });

  it("reports missing tools as null / false", async () => {
    const r = rig();
    r.archive.availableValue = null;
    const facts = await r.service.toolFacts();
    expect(facts.sevenZip).toBeNull();
  });
});

describe("PublishService.remoteUrl", () => {
  it("returns the git port's origin remote URL by default", async () => {
    const r = rig();
    r.git.remoteUrlValue = "https://github.com/octocat/mod.git";
    expect(await r.service.remoteUrl(ROOT)).toBe("https://github.com/octocat/mod.git");
    expect(r.git.calls).toContainEqual(["getRemoteUrl", ROOT, "origin"]);
  });

  it("passes an explicit remote name through and returns null when unset", async () => {
    const r = rig();
    expect(await r.service.remoteUrl(ROOT, "upstream")).toBeNull();
    expect(r.git.calls).toContainEqual(["getRemoteUrl", ROOT, "upstream"]);
  });
});
