import { describe, it, expect } from "vitest";
import * as path from "path";
import { PublishService, type PublishPorts } from "../../src/core/app/publishService";
import type { GitPort } from "../../src/core/ports/git";
import type {
  GhPort,
  GhRepoCreateOptions,
  GhRepoCreateResult,
  GhReleaseCreateOptions,
} from "../../src/core/ports/gh";
import type { ArchivePort } from "../../src/core/ports/archive";
import type { FileSystemPort } from "../../src/core/ports/filesystem";
import type { ManifestPort } from "../../src/core/ports/manifest";
import type { InstallRoots, ManifestModel, PackagedPayload } from "../../src/core/domain/types";
import { DEFAULT_VOLUME_BYTES } from "../../src/core/domain/archivePolicy";

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
  async getRemoteUrl(root: string, remote?: string): Promise<string | null> {
    this.calls.push(["getRemoteUrl", root, remote]);
    return null;
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
  async isInstalled(): Promise<boolean> {
    this.calls.push(["isInstalled"]);
    return true;
  }
  async isAuthed(): Promise<boolean> {
    this.calls.push(["isAuthed"]);
    return true;
  }
  async login(): Promise<string | null> {
    this.calls.push(["login"]);
    return this.loginValue;
  }
  async repoCreate(opts: GhRepoCreateOptions): Promise<GhRepoCreateResult> {
    this.calls.push(["repoCreate", opts]);
    return this.repoCreateResult;
  }
  async repoTopicAdd(repo: string, topic: string): Promise<void> {
    this.calls.push(["repoTopicAdd", repo, topic]);
  }
  async releaseView(repo: string, tag: string): Promise<boolean> {
    this.calls.push(["releaseView", repo, tag]);
    return false;
  }
  async releaseDelete(repo: string, tag: string): Promise<void> {
    this.calls.push(["releaseDelete", repo, tag]);
  }
  async releaseCreate(opts: GhReleaseCreateOptions): Promise<void> {
    this.calls.push(["releaseCreate", opts]);
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

class FakeFs implements FileSystemPort {
  calls: unknown[][] = [];
  files = new Map<string, string>();
  async readText(p: string): Promise<string> {
    this.calls.push(["readText", p]);
    const text = this.files.get(p);
    if (text === undefined) throw new Error(`ENOENT: ${p}`);
    return text;
  }
  async writeText(p: string, contents: string): Promise<void> {
    this.calls.push(["writeText", p, contents]);
    this.files.set(p, contents);
  }
  async exists(p: string): Promise<boolean> {
    this.calls.push(["exists", p]);
    return this.files.has(p);
  }
  async isDirectory(p: string): Promise<boolean> {
    this.calls.push(["isDirectory", p]);
    return false;
  }
  async readDir(p: string): Promise<string[]> {
    this.calls.push(["readDir", p]);
    return [];
  }
  async remove(p: string): Promise<void> {
    this.calls.push(["remove", p]);
    this.files.delete(p);
  }
  async mkdirp(p: string): Promise<void> {
    this.calls.push(["mkdirp", p]);
  }
  async copy(src: string, dest: string): Promise<void> {
    this.calls.push(["copy", src, dest]);
    this.files.set(dest, this.files.get(src) ?? "");
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
  fs: FakeFs;
  manifest: FakeManifest;
  service: PublishService;
  logs: string[];
  log: (line: string) => void;
}

function rig(): Rig {
  const git = new FakeGit();
  const gh = new FakeGh();
  const archive = new FakeArchive();
  const fs = new FakeFs();
  const manifest = new FakeManifest();
  const ports: PublishPorts = { git, gh, archive, fs, manifest };
  const logs: string[] = [];
  return { git, gh, archive, fs, manifest, service: new PublishService(ports), logs, log: (l) => logs.push(l) };
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
    const res = await r.service.share(ROOT, { name: "my-mod", description: "A mod" }, r.log);

    expect(r.git.calls).toEqual([
      ["isRepo", ROOT],
      ["init", ROOT],
      ["addAll", ROOT],
      ["hasChanges", ROOT],
      ["commit", ROOT, "Publish with DCS Studio"],
    ]);
    expect(r.fs.files.get(gitignorePath)).toBe(".dcs-studio/\n");
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
    expect(res).toEqual({ owner: "octocat", name: "my-mod", url: "https://github.com/octocat/my-mod" });
    expect(r.logs).toEqual([
      "git init",
      "git commit",
      "Creating GitHub repo octocat/my-mod…",
      "Tagging topic: dcs-studio",
    ]);
  });

  it("existing repo with a clean tree: skips init and commit", async () => {
    const r = rig();
    r.git.changes = false;
    r.fs.files.set(gitignorePath, "out/\n.dcs-studio/\n");
    await r.service.share(ROOT, { name: "mod", description: "" }, r.log);

    expect(r.git.calls).toEqual([
      ["isRepo", ROOT],
      ["addAll", ROOT],
      ["hasChanges", ROOT],
    ]);
    // .gitignore already carried the entry — nothing rewritten.
    expect(r.fs.calls.filter((c) => c[0] === "writeText")).toEqual([]);
    expect(r.logs).toEqual(["Creating GitHub repo octocat/mod…", "Tagging topic: dcs-studio"]);
  });

  it("appends the ignore entry to an existing .gitignore missing a trailing newline", async () => {
    const r = rig();
    r.fs.files.set(gitignorePath, "out/");
    await r.service.share(ROOT, { name: "mod", description: "" }, r.log);
    expect(r.fs.files.get(gitignorePath)).toBe("out/\n.dcs-studio/\n");
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

});

// ── cutRelease ───────────────────────────────────────────────────────────────

const manifestPath = path.join(ROOT, "dcs-studio.toml");
const outDir = path.join(ROOT, ".dcs-studio", "release");
const manifestAsset = path.join(outDir, "dcs-studio.toml");
const releaseOpts = { owner: "octocat", name: "mod", tag: "v1.0.0", notes: "" };

/** A rig whose manifest + files are set up for a successful release. */
function releaseRig(bundle: { path: string }[] = []) {
  const r = rig();
  r.fs.files.set(manifestPath, "[project]");
  r.manifest.model = model(bundle);
  for (const b of bundle) r.fs.files.set(path.join(ROOT, b.path), "built");
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
    await expect(r.service.cutRelease(ROOT, releaseOpts, r.log)).rejects.toThrow("Cannot read dcs-studio.toml.");
  });

  it("rejects when the manifest does not parse", async () => {
    const r = rig();
    r.fs.files.set(manifestPath, "not toml");
    r.manifest.model = null; // parseToml throws
    await expect(r.service.cutRelease(ROOT, releaseOpts, r.log)).rejects.toThrow("Cannot read dcs-studio.toml.");
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
      ["packagePayload", ROOT, ["dcs-studio.toml", "out/mod"], outDir, "dcs-studio-mod-v1.0.0", undefined],
    ]);
    // The standalone manifest is copied alongside the payload.
    expect(r.fs.calls).toContainEqual(["copy", manifestPath, manifestAsset]);
    // Idempotent re-publish: delete first, then create with all assets.
    expect(r.gh.calls).toEqual([
      ["releaseDelete", "octocat/mod", "v1.0.0"],
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
    expect((create?.[1] as { notes: string }).notes).toBe("Release v1.0.0");
  });

  it("re-release: deletes the previous release before creating the new one", async () => {
    const r = releaseRig();
    await r.service.cutRelease(ROOT, releaseOpts, r.log);
    const order = r.gh.calls.map((c) => c[0]);
    expect(order.indexOf("releaseDelete")).toBeLessThan(order.indexOf("releaseCreate"));
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
});
