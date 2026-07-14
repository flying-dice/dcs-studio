import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { type Progress, SubscriptionService } from "../../src/core/app/subscriptionService";
import {
  AFTER_SANITIZE_FILE,
  BEFORE_SANITIZE_FILE,
  toPosix,
} from "../../src/core/domain/missionScriptAggregator";
import type {
  InstallTarget,
  LinkResult,
  ManifestModel,
  Subscription,
} from "../../src/core/domain/types";
import type { ArchivePort } from "../../src/core/ports/archive";
import type { ClockPort } from "../../src/core/ports/clock";
import type { DownloadPort } from "../../src/core/ports/downloader";
import type { FileSystemPort } from "../../src/core/ports/filesystem";
import type { InstallRootsPort } from "../../src/core/ports/installRoots";
import type { SubscriptionLedgerStore } from "../../src/core/ports/ledger";
import type { LinkerPort } from "../../src/core/ports/linker";
import type { ManifestPort } from "../../src/core/ports/manifest";

// Full subscription-lifecycle tests against in-memory fake ports — no vscode, no
// fs, no network. The fakes record every interaction so the tests can assert the
// exact semantics manager.ts used to have (tolerant reads, .download handling,
// enabled-state preservation, verbatim error messages and progress labels).

const DATA = "D:\\data";
const SEP = path.sep;

// ── fakes ────────────────────────────────────────────────────────────────────

class FakeLedger implements SubscriptionLedgerStore {
  store: Record<string, Subscription> = {};
  saves: Record<string, Subscription>[] = [];

  async load(): Promise<Record<string, Subscription>> {
    // A fresh object each time, like re-reading a JSON file.
    return JSON.parse(JSON.stringify(this.store));
  }

  async save(subs: Record<string, Subscription>): Promise<void> {
    this.store = JSON.parse(JSON.stringify(subs));
    this.saves.push(this.store);
  }
}

class FakeFs implements FileSystemPort {
  files = new Map<string, string>();
  dirs = new Set<string>();
  removed: string[] = [];

  async readText(p: string): Promise<string> {
    const c = this.files.get(p);
    if (c === undefined) throw new Error(`ENOENT: ${p}`);
    return c;
  }
  async writeText(p: string, contents: string): Promise<void> {
    this.files.set(p, contents);
  }
  async exists(p: string): Promise<boolean> {
    return this.files.has(p) || this.dirs.has(p);
  }
  async isDirectory(p: string): Promise<boolean> {
    return this.dirs.has(p);
  }
  async readDir(p: string): Promise<string[]> {
    const out = new Set<string>();
    for (const k of [...this.files.keys(), ...this.dirs]) {
      if (k.startsWith(p + SEP)) out.add(k.slice(p.length + 1).split(SEP)[0]);
    }
    return [...out];
  }
  async remove(p: string): Promise<void> {
    this.removed.push(p);
    for (const k of [...this.files.keys()]) {
      if (k === p || k.startsWith(p + SEP)) this.files.delete(k);
    }
    for (const d of [...this.dirs]) {
      if (d === p || d.startsWith(p + SEP)) this.dirs.delete(d);
    }
  }
  async mkdirp(p: string): Promise<void> {
    this.dirs.add(p);
  }
  async copy(src: string, dest: string): Promise<void> {
    this.files.set(dest, this.files.get(src) ?? "");
  }
}

class FakeDownloader implements DownloadPort {
  calls: { url: string; dest: string; token?: string }[] = [];
  /** Content written per downloaded file; keyed by url, default the url itself. */
  content = new Map<string, string>();
  /** Progress fractions to report per download (when a callback is given). */
  fractions: number[] = [];

  constructor(private readonly fs: FakeFs) {}

  async download(
    url: string,
    dest: string,
    token?: string,
    onProgress?: (f: number) => void,
  ): Promise<void> {
    this.calls.push({ url, dest, token });
    if (onProgress) for (const f of this.fractions) onProgress(f);
    this.fs.files.set(dest, this.content.get(url) ?? url);
  }
}

class FakeArchive implements ArchivePort {
  cmd: string | null = "7z";
  extracts: { archive: string; outDir: string }[] = [];
  /** Files (relative to outDir) the fake "unpacks" on extract. */
  unpacked = new Map<string, string>();

  constructor(private readonly fs: FakeFs) {}

  async available(): Promise<string | null> {
    return this.cmd;
  }
  async extract(archive: string, outDir: string): Promise<void> {
    this.extracts.push({ archive, outDir });
    for (const [rel, content] of this.unpacked) this.fs.files.set(path.join(outDir, rel), content);
  }
  async packagePayload(): Promise<never> {
    throw new Error("not used by the subscription service");
  }
}

class FakeLinker implements LinkerPort {
  enables: { id: string; src: string; dest: string }[][] = [];
  disables: { id: string; installedPath: string }[][] = [];
  result: LinkResult | undefined;

  async enable(defs: { id: string; src: string; dest: string }[]): Promise<LinkResult> {
    this.enables.push(defs);
    return (
      this.result ?? {
        ok: true,
        created: defs.map((d) => ({ id: d.id, src: d.src, dest: d.dest })),
      }
    );
  }
  disable(installed: { id: string; installedPath: string }[]): { removed: string[]; failed: [] } {
    this.disables.push(installed);
    return { removed: installed.map((l) => l.id), failed: [] };
  }
}

class FakeManifest implements ManifestPort {
  parseToml(text: string): ManifestModel {
    return JSON.parse(text) as ManifestModel;
  }
  emitToml(model: ManifestModel): string {
    return JSON.stringify(model);
  }
  resolveDest(dest: string, roots: { savedGames: string; gameInstall: string }): string | null {
    if (dest.startsWith("{SavedGames}"))
      return roots.savedGames + dest.slice("{SavedGames}".length);
    if (dest.startsWith("{GameInstall}")) {
      return roots.gameInstall ? roots.gameInstall + dest.slice("{GameInstall}".length) : null;
    }
    return dest;
  }
}

class FakeRoots implements InstallRootsPort {
  game: string | undefined = "E:\\DCS";
  savedGames(): string {
    return "C:\\SG\\DCS";
  }
  gameInstall(): string | undefined {
    return this.game;
  }
  dataDir(): string {
    return DATA;
  }
}

class FakeClock implements ClockPort {
  t = 1_000;
  now(): number {
    return this.t;
  }
}

function makeWorld() {
  const fs = new FakeFs();
  const ledger = new FakeLedger();
  const downloader = new FakeDownloader(fs);
  const archive = new FakeArchive(fs);
  const linker = new FakeLinker();
  const manifest = new FakeManifest();
  const roots = new FakeRoots();
  const clock = new FakeClock();
  const service = new SubscriptionService({
    ledger,
    archive,
    downloader,
    linker,
    manifest,
    roots,
    fs,
    clock,
  });
  const progress: Progress[] = [];
  const onProgress = (p: Progress) => progress.push(p);
  return {
    fs,
    ledger,
    downloader,
    archive,
    linker,
    manifest,
    roots,
    clock,
    service,
    progress,
    onProgress,
  };
}

const MODEL: ManifestModel = {
  project: { name: "My Mod", version: "1.0.0", author: "a", description: "" },
  bundle: [{ path: "Scripts/X" }],
  symlink: [{ source: "Scripts/X", dest: "{SavedGames}/Scripts/X" }],
  requires_module: [{ id: "ed/f16c" }],
  entrypoint: [],
  mission_script: [],
  extras: [],
};

const target = (over: Partial<InstallTarget> = {}): InstallTarget => ({
  repo: "Owner/Repo",
  name: "My Mod",
  tag: "v1.0.0",
  assets: [{ name: "mod.7z", size: 10, url: "https://dl/mod.7z" }],
  ...over,
});

const MOD_DIR = path.join(DATA, "Owner__Repo");
const DL_DIR = path.join(MOD_DIR, ".download");
// The managed aggregator files land under <savedGames>/Scripts (FakeRoots).
const AGG_DIR = path.join("C:\\SG\\DCS", "Scripts");
const BEFORE_AGG = path.join(AGG_DIR, BEFORE_SANITIZE_FILE);
const AFTER_AGG = path.join(AGG_DIR, AFTER_SANITIZE_FILE);

const seeded = (over: Partial<Subscription> = {}): Subscription => ({
  repo: "Owner/Repo",
  name: "My Mod",
  tag: "v1.0.0",
  dir: MOD_DIR,
  enabled: false,
  links: [],
  bundles: [],
  symlinks: [],
  entrypoints: [],
  missionScripts: [],
  ...over,
});

// ── queries ──────────────────────────────────────────────────────────────────

describe("list / get / isSubscribed / isEnabled", () => {
  it("lists subscriptions sorted by name", async () => {
    const w = makeWorld();
    w.ledger.store = {
      "b/b": seeded({ repo: "b/b", name: "Zulu" }),
      "a/a": seeded({ repo: "a/a", name: "Alpha" }),
    };
    expect((await w.service.list()).map((s) => s.name)).toEqual(["Alpha", "Zulu"]);
  });

  it("gets by repo case-insensitively (lowercased ledger key)", async () => {
    const w = makeWorld();
    w.ledger.store = { "owner/repo": seeded() };
    expect((await w.service.get("OWNER/Repo"))?.name).toBe("My Mod");
    expect(await w.service.get("other/mod")).toBeUndefined();
  });

  it("reports subscription and enabled state", async () => {
    const w = makeWorld();
    w.ledger.store = { "owner/repo": seeded({ enabled: true }) };
    expect(await w.service.isSubscribed("Owner/Repo")).toBe(true);
    expect(await w.service.isSubscribed("nope/nope")).toBe(false);
    expect(await w.service.isEnabled("Owner/Repo")).toBe(true);
    expect(await w.service.isEnabled("nope/nope")).toBe(false);
  });

  it("isEnabled is false for a subscribed-but-disabled mod", async () => {
    const w = makeWorld();
    w.ledger.store = { "owner/repo": seeded({ enabled: false }) };
    expect(await w.service.isEnabled("Owner/Repo")).toBe(false);
  });
});

// ── fetchPlan ────────────────────────────────────────────────────────────────

describe("fetchPlan", () => {
  it("returns null when the release carries no manifest asset", async () => {
    const w = makeWorld();
    const plan = await w.service.fetchPlan([{ name: "mod.7z", size: 1, url: "u" }], undefined);
    expect(plan).toBeNull();
    expect(w.downloader.calls).toEqual([]);
  });

  it("downloads the manifest to a clock-stamped tmp file, maps the plan, and cleans up", async () => {
    const w = makeWorld();
    w.clock.t = 42;
    w.downloader.content.set("https://dl/dcs-studio.toml", JSON.stringify(MODEL));
    const tmp = path.join(DATA, ".tmp", "42-dcs-studio.toml");

    const plan = await w.service.fetchPlan(
      [{ name: "dcs-studio.toml", size: 1, url: "https://dl/dcs-studio.toml" }],
      "tok",
    );

    expect(w.downloader.calls).toEqual([
      { url: "https://dl/dcs-studio.toml", dest: tmp, token: "tok" },
    ]);
    expect(plan).toEqual({
      bundles: [{ path: "Scripts/X" }],
      symlinks: [
        { source: "Scripts/X", dest: "{SavedGames}/Scripts/X", resolved: "C:\\SG\\DCS/Scripts/X" },
      ],
      entrypoints: [],
      missionScripts: [],
      requires: [{ id: "ed/f16c" }],
    });
    // tmp cleanup
    expect(w.fs.files.has(tmp)).toBe(false);
    expect(w.fs.removed).toContain(tmp);
  });

  it("resolves {GameInstall} dests to null when the game install is unconfigured", async () => {
    const w = makeWorld();
    w.roots.game = undefined;
    const model: ManifestModel = {
      ...MODEL,
      symlink: [{ source: "Mods/X", dest: "{GameInstall}/Mods/X" }],
    };
    w.downloader.content.set("https://dl/dcs-studio.toml", JSON.stringify(model));
    const plan = await w.service.fetchPlan(
      [{ name: "dcs-studio.toml", size: 1, url: "https://dl/dcs-studio.toml" }],
      undefined,
    );
    expect(plan?.symlinks).toEqual([
      { source: "Mods/X", dest: "{GameInstall}/Mods/X", resolved: null },
    ]);
  });
});

// ── subscribe ────────────────────────────────────────────────────────────────

describe("subscribe", () => {
  it("fails with the exact 7-Zip message when no archiver is available", async () => {
    const w = makeWorld();
    w.archive.cmd = null;
    await expect(w.service.subscribe(target(), undefined, w.onProgress)).rejects.toThrow(
      "7-Zip not found — install 7-Zip (7-zip.org) to install mods.",
    );
    expect(w.downloader.calls).toEqual([]);
  });

  it("fails with the exact no-payload message when the release has no .7z volumes", async () => {
    const w = makeWorld();
    await expect(
      w.service.subscribe(
        target({ assets: [{ name: "readme.md", size: 1, url: "u" }] }),
        undefined,
        w.onProgress,
      ),
    ).rejects.toThrow("This release has no .7z payload to install.");
  });

  it("downloads each volume in order into <dir>/.download, extracts the first, and records the ledger entry", async () => {
    const w = makeWorld();
    const t = target({
      assets: [
        { name: "big.7z.002", size: 2, url: "https://dl/big.7z.002" },
        { name: "dcs-studio.toml", size: 1, url: "https://dl/m.toml" },
        { name: "big.7z.001", size: 2, url: "https://dl/big.7z.001" },
      ],
    });
    const sub = await w.service.subscribe(t, "tok", w.onProgress);

    // Sorted volumes, manifest asset ignored, downloads land in .download.
    expect(w.downloader.calls).toEqual([
      { url: "https://dl/big.7z.001", dest: path.join(DL_DIR, "big.7z.001"), token: "tok" },
      { url: "https://dl/big.7z.002", dest: path.join(DL_DIR, "big.7z.002"), token: "tok" },
    ]);
    // Extraction points at the first volume; the archiver finds its siblings.
    expect(w.archive.extracts).toEqual([
      { archive: path.join(DL_DIR, "big.7z.001"), outDir: MOD_DIR },
    ]);
    // The .download dir is cleaned up afterwards.
    expect(w.fs.removed).toContain(DL_DIR);

    expect(sub).toEqual({
      repo: "Owner/Repo",
      name: "My Mod",
      tag: "v1.0.0",
      dir: MOD_DIR,
      enabled: false,
      links: [],
      bundles: [],
      symlinks: [],
      entrypoints: [],
      missionScripts: [],
    });
    expect(w.ledger.store["owner/repo"]).toEqual(sub);

    // Progress: per-volume download labels, extract, done — verbatim.
    expect(w.progress.map((p) => [p.phase, p.label, p.pct])).toEqual([
      ["download", "Downloading big.7z.001 (1/2)", 0],
      ["download", "Downloading big.7z.002 (2/2)", 0],
      ["extract", "Extracting payload…", undefined],
      ["done", "Subscribed (downloaded & unpacked).", undefined],
    ]);
  });

  it("forwards download progress fractions", async () => {
    const w = makeWorld();
    w.downloader.fractions = [0.25, 1];
    await w.service.subscribe(target(), undefined, w.onProgress);
    const pcts = w.progress.filter((p) => p.phase === "download").map((p) => p.pct);
    expect(pcts).toEqual([0, 0.25, 1]);
  });

  it("clears prior unpacked content but keeps .download until extraction is done", async () => {
    const w = makeWorld();
    w.fs.dirs.add(MOD_DIR);
    w.fs.files.set(path.join(MOD_DIR, "old-file.lua"), "stale");
    w.fs.dirs.add(path.join(MOD_DIR, "old-dir"));

    await w.service.subscribe(target(), undefined, w.onProgress);

    expect(w.fs.files.has(path.join(MOD_DIR, "old-file.lua"))).toBe(false);
    expect(w.fs.dirs.has(path.join(MOD_DIR, "old-dir"))).toBe(false);
    // .download was never cleared as part of the prior-content sweep — only
    // removed once (pre-download reset) plus once after extraction.
    const dlRemovals = w.fs.removed.filter((p) => p === DL_DIR);
    expect(dlRemovals).toHaveLength(2);
  });

  it("snapshots the unpacked manifest's entrypoints onto the ledger entry", async () => {
    const w = makeWorld();
    const withEps: ManifestModel = {
      ...MODEL,
      entrypoint: [
        { id: "srs", name: "SRS", exe: "Server/SR.exe", args: ["--min"], cwd: "Server" },
      ],
    };
    w.archive.unpacked.set("dcs-studio.toml", JSON.stringify(withEps));

    const sub = await w.service.subscribe(target(), undefined, w.onProgress);

    expect(sub.entrypoints).toEqual([
      { id: "srs", name: "SRS", exe: "Server/SR.exe", args: ["--min"], cwd: "Server" },
    ]);
    expect(w.ledger.store["owner/repo"].entrypoints).toEqual(sub.entrypoints);
    // The same snapshot also captures bundles + symlinks for the My Mods breakdown.
    expect(sub.bundles).toEqual([{ path: "Scripts/X" }]);
    expect(sub.symlinks).toEqual([{ source: "Scripts/X", dest: "{SavedGames}/Scripts/X" }]);
  });

  it("snapshots no entrypoints when the payload has no manifest on disk", async () => {
    const w = makeWorld();
    // No archive.unpacked manifest → readText throws → tolerant empty snapshot.
    const sub = await w.service.subscribe(target(), undefined, w.onProgress);
    expect(sub.entrypoints).toEqual([]);
    expect(sub.missionScripts).toEqual([]);
  });

  it("snapshots the unpacked manifest's mission scripts onto the ledger entry", async () => {
    const w = makeWorld();
    const withMs: ManifestModel = {
      ...MODEL,
      mission_script: [{ name: "Loader", path: "Scripts/l.lua", run_on: "before-sanitize" }],
    };
    w.archive.unpacked.set("dcs-studio.toml", JSON.stringify(withMs));

    const sub = await w.service.subscribe(target(), undefined, w.onProgress);

    expect(sub.missionScripts).toEqual([
      { name: "Loader", path: "Scripts/l.lua", run_on: "before-sanitize" },
    ]);
    expect(w.ledger.store["owner/repo"].missionScripts).toEqual(sub.missionScripts);
  });

  it("tolerates a manifest lacking the entrypoint/mission_script fields (older schema)", async () => {
    const w = makeWorld();
    const old = {
      project: MODEL.project,
      bundle: [],
      symlink: [],
      requires_module: [],
      extras: [],
    };
    w.archive.unpacked.set("dcs-studio.toml", JSON.stringify(old));

    const sub = await w.service.subscribe(target(), undefined, w.onProgress);

    expect(sub.entrypoints).toEqual([]);
    expect(sub.missionScripts).toEqual([]);
  });

  it("preserves the prior enabled state and links on re-subscribe (update path)", async () => {
    const w = makeWorld();
    const links = [{ id: "Owner/Repo:0", dest: "C:\\SG\\DCS\\Scripts\\X" }];
    w.ledger.store = { "owner/repo": seeded({ tag: "v0.9.0", enabled: true, links }) };

    const sub = await w.service.subscribe(target({ tag: "v1.0.0" }), undefined, w.onProgress);

    expect(sub.tag).toBe("v1.0.0");
    expect(sub.enabled).toBe(true);
    expect(sub.links).toEqual(links);
  });
});

// ── enable / disable ─────────────────────────────────────────────────────────

function seedInstalled(w: ReturnType<typeof makeWorld>, over: Partial<Subscription> = {}): void {
  w.ledger.store = { "owner/repo": seeded(over) };
  w.fs.files.set(path.join(MOD_DIR, "dcs-studio.toml"), JSON.stringify(MODEL));
}

describe("enable", () => {
  it("throws the exact message when not subscribed", async () => {
    const w = makeWorld();
    await expect(w.service.enable("Owner/Repo")).rejects.toThrow("Not subscribed.");
  });

  it("is a no-op when already enabled", async () => {
    const w = makeWorld();
    seedInstalled(w, { enabled: true });
    await w.service.enable("Owner/Repo");
    expect(w.linker.enables).toEqual([]);
    expect(w.ledger.saves).toEqual([]);
  });

  it("links each install rule to its resolved destination and persists the created links", async () => {
    const w = makeWorld();
    seedInstalled(w);
    await w.service.enable("Owner/Repo");

    expect(w.linker.enables).toEqual([
      [
        {
          id: "Owner/Repo:0",
          src: path.join(MOD_DIR, "Scripts/X"),
          dest: "C:\\SG\\DCS/Scripts/X",
        },
      ],
    ]);
    const saved = w.ledger.store["owner/repo"];
    expect(saved.enabled).toBe(true);
    expect(saved.links).toEqual([{ id: "Owner/Repo:0", dest: "C:\\SG\\DCS/Scripts/X" }]);
  });

  it("throws the exact message when a dest cannot be resolved", async () => {
    const w = makeWorld();
    w.roots.game = undefined;
    const model = { ...MODEL, symlink: [{ source: "Mods/X", dest: "{GameInstall}/Mods/X" }] };
    w.ledger.store = { "owner/repo": seeded() };
    w.fs.files.set(path.join(MOD_DIR, "dcs-studio.toml"), JSON.stringify(model));

    await expect(w.service.enable("Owner/Repo")).rejects.toThrow(
      "Cannot resolve {GameInstall}/Mods/X — configure {GameInstall} in Settings.",
    );
    expect(w.linker.enables).toEqual([]);
  });

  it("propagates the linker failure message and does not persist", async () => {
    const w = makeWorld();
    seedInstalled(w);
    w.linker.result = { ok: false, message: "Destination path already exists: X" };

    await expect(w.service.enable("Owner/Repo")).rejects.toThrow(
      "Destination path already exists: X",
    );
    expect(w.ledger.saves).toEqual([]);
    expect(w.ledger.store["owner/repo"].enabled).toBe(false);
  });
});

describe("disable", () => {
  it("is a no-op when not subscribed or not enabled", async () => {
    const w = makeWorld();
    await w.service.disable("Owner/Repo");
    w.ledger.store = { "owner/repo": seeded({ enabled: false }) };
    await w.service.disable("Owner/Repo");
    expect(w.linker.disables).toEqual([]);
    expect(w.ledger.saves).toEqual([]);
  });

  it("removes the links and persists the disabled state", async () => {
    const w = makeWorld();
    const links = [
      { id: "Owner/Repo:0", dest: "C:\\SG\\DCS\\Scripts\\X" },
      { id: "Owner/Repo:1", dest: "C:\\SG\\DCS\\Mods\\Y" },
    ];
    w.ledger.store = { "owner/repo": seeded({ enabled: true, links }) };

    await w.service.disable("Owner/Repo");

    expect(w.linker.disables).toEqual([
      [
        { id: "Owner/Repo:0", installedPath: "C:\\SG\\DCS\\Scripts\\X" },
        { id: "Owner/Repo:1", installedPath: "C:\\SG\\DCS\\Mods\\Y" },
      ],
    ]);
    expect(w.ledger.store["owner/repo"]).toMatchObject({ enabled: false, links: [] });
  });
});

// ── aggregator regeneration ──────────────────────────────────────────────────

const absScript = (rel: string) => toPosix(path.join(MOD_DIR, rel));

describe("aggregator regeneration", () => {
  it("enable regenerates both aggregator files, guarded, tagged, and split by run_on", async () => {
    const w = makeWorld();
    seedInstalled(w, {
      missionScripts: [
        { name: "Before", path: "Scripts/b.lua", run_on: "before-sanitize" },
        { name: "After", path: "Scripts/a.lua", run_on: "after-sanitize" },
      ],
    });

    await w.service.enable("Owner/Repo");

    const before = w.fs.files.get(BEFORE_AGG)!;
    const after = w.fs.files.get(AFTER_AGG)!;
    expect(before).toContain("local function dofileifexist");
    expect(before).toContain("-- Owner/Repo@v1.0.0");
    expect(before).toContain(`dofileifexist([[${absScript("Scripts/b.lua")}]])`);
    expect(before).not.toContain("Scripts/a.lua");
    expect(after).toContain(`dofileifexist([[${absScript("Scripts/a.lua")}]])`);
    expect(after).not.toContain("Scripts/b.lua");
  });

  it("disable regenerates the aggregators as guard-only (disabled mod excluded)", async () => {
    const w = makeWorld();
    w.ledger.store = {
      "owner/repo": seeded({
        enabled: true,
        links: [{ id: "Owner/Repo:0", dest: "C:\\SG\\DCS\\Scripts\\X" }],
        missionScripts: [{ name: "S", path: "Scripts/s.lua", run_on: "after-sanitize" }],
      }),
    };

    await w.service.disable("Owner/Repo");

    const after = w.fs.files.get(AFTER_AGG)!;
    expect(after).toContain("local function dofileifexist"); // still a valid guard-only file
    expect(after).not.toContain("Scripts/s.lua"); // no stale reference to the disabled mod
  });

  it("unsubscribe regenerates the aggregators without the removed mod's scripts", async () => {
    const w = makeWorld();
    w.ledger.store = {
      "owner/repo": seeded({
        enabled: true,
        links: [],
        missionScripts: [{ name: "S", path: "Scripts/s.lua", run_on: "before-sanitize" }],
      }),
    };

    await w.service.unsubscribe("Owner/Repo");

    const before = w.fs.files.get(BEFORE_AGG)!;
    expect(before).toContain("local function dofileifexist");
    expect(before).not.toContain("Scripts/s.lua");
  });

  it("only enabled mods contribute, and a legacy entry with no missionScripts field is tolerated", async () => {
    const w = makeWorld();
    seedInstalled(w, {
      missionScripts: [{ name: "Live", path: "Scripts/live.lua", run_on: "after-sanitize" }],
    });
    // A disabled mod (must be skipped) and an enabled legacy entry whose
    // missionScripts field predates this feature (must not throw).
    w.ledger.store["disabled/mod"] = seeded({
      repo: "disabled/mod",
      enabled: false,
      missionScripts: [{ name: "Ghost", path: "Scripts/ghost.lua", run_on: "after-sanitize" }],
    });
    w.ledger.store["legacy/mod"] = {
      ...seeded({ repo: "legacy/mod", enabled: true }),
      missionScripts: undefined as unknown as Subscription["missionScripts"],
    };

    await w.service.enable("Owner/Repo");

    const after = w.fs.files.get(AFTER_AGG)!;
    expect(after).toContain("Scripts/live.lua");
    expect(after).not.toContain("Scripts/ghost.lua"); // disabled mod excluded
  });
});

// ── install / update / unsubscribe ───────────────────────────────────────────

describe("install", () => {
  it("subscribes then enables, with the exact phase labels in order", async () => {
    const w = makeWorld();
    w.archive.unpacked.set("dcs-studio.toml", JSON.stringify(MODEL));

    await w.service.install(target(), undefined, w.onProgress);

    expect(w.progress.map((p) => [p.phase, p.label])).toEqual([
      ["download", "Downloading mod.7z (1/1)"],
      ["extract", "Extracting payload…"],
      ["done", "Subscribed (downloaded & unpacked)."],
      ["link", "Linking into DCS…"],
      ["done", "Installed."],
    ]);
    expect(w.ledger.store["owner/repo"].enabled).toBe(true);
  });
});

describe("update", () => {
  it("preserves enabled state: disables, re-downloads, re-links", async () => {
    const w = makeWorld();
    const links = [{ id: "Owner/Repo:0", dest: "C:\\SG\\DCS/Scripts/X" }];
    w.ledger.store = { "owner/repo": seeded({ tag: "v1.0.0", enabled: true, links }) };
    w.archive.unpacked.set("dcs-studio.toml", JSON.stringify(MODEL));

    await w.service.update(target({ tag: "v2.0.0" }), undefined, w.onProgress);

    expect(w.linker.disables).toHaveLength(1);
    expect(w.linker.enables).toHaveLength(1);
    const saved = w.ledger.store["owner/repo"];
    expect(saved.tag).toBe("v2.0.0");
    expect(saved.enabled).toBe(true);
    expect(w.progress.map((p) => p.label)).toContain("Re-linking updated files…");
    expect(w.progress.at(-1)).toEqual({ phase: "done", label: "Updated to v2.0.0." });
  });

  it("leaves a disabled subscription disabled (no re-link)", async () => {
    const w = makeWorld();
    w.ledger.store = { "owner/repo": seeded({ tag: "v1.0.0", enabled: false }) };

    await w.service.update(target({ tag: "v2.0.0" }), undefined, w.onProgress);

    expect(w.linker.disables).toEqual([]);
    expect(w.linker.enables).toEqual([]);
    const saved = w.ledger.store["owner/repo"];
    expect(saved.tag).toBe("v2.0.0");
    expect(saved.enabled).toBe(false);
    expect(w.progress.map((p) => p.label)).not.toContain("Re-linking updated files…");
    expect(w.progress.at(-1)).toEqual({ phase: "done", label: "Updated to v2.0.0." });
  });
});

describe("unsubscribe", () => {
  it("is a no-op when not subscribed", async () => {
    const w = makeWorld();
    await w.service.unsubscribe("Owner/Repo");
    expect(w.ledger.saves).toEqual([]);
    expect(w.fs.removed).toEqual([]);
  });

  it("removes links (when enabled), deletes the unpacked dir, and drops the ledger entry", async () => {
    const w = makeWorld();
    const links = [{ id: "Owner/Repo:0", dest: "C:\\SG\\DCS\\Scripts\\X" }];
    w.ledger.store = { "owner/repo": seeded({ enabled: true, links }) };

    await w.service.unsubscribe("OWNER/REPO"); // case-insensitive

    expect(w.linker.disables).toEqual([
      [{ id: "Owner/Repo:0", installedPath: "C:\\SG\\DCS\\Scripts\\X" }],
    ]);
    expect(w.fs.removed).toContain(MOD_DIR);
    expect(w.ledger.store).toEqual({});
  });

  it("skips the linker for a disabled subscription but still deletes and drops it", async () => {
    const w = makeWorld();
    w.ledger.store = { "owner/repo": seeded({ enabled: false }) };

    await w.service.unsubscribe("Owner/Repo");

    expect(w.linker.disables).toEqual([]);
    expect(w.fs.removed).toContain(MOD_DIR);
    expect(w.ledger.store).toEqual({});
  });
});
