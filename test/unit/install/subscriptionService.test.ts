import { win32 as path } from "node:path";
import { describe, expect, it } from "vitest";
import { type Progress, SubscriptionService } from "../../../src/core/app/subscriptionService";
import {
  AFTER_SANITIZE_FILE,
  BEFORE_SANITIZE_FILE,
  toPosix,
} from "../../../src/core/domain/missionScriptAggregator";
import { renderUninstallScript } from "../../../src/core/domain/subscriptions";
import type {
  DisableResult,
  InstallTarget,
  LinkResult,
  ManifestModel,
  Subscription,
} from "../../../src/core/domain/types";
import type { ArchivePort } from "../../../src/core/ports/archive";
import type { ClockPort } from "../../../src/core/ports/clock";
import type { DownloadPort } from "../../../src/core/ports/downloader";
import type { InstallRootsPort } from "../../../src/core/ports/installRoots";
import type { LedgerRead, SubscriptionLedgerStore } from "../../../src/core/ports/ledger";
import type { LinkerPort } from "../../../src/core/ports/linker";
import type { ManifestPort } from "../../../src/core/ports/manifest";
import { MemFileSystem } from "../../support/memFileSystem";
import { RecordingFileSystem } from "../../support/recordingFileSystem";

// Full subscription-lifecycle tests against in-memory fake ports — no vscode, no
// fs, no network. The fakes record every interaction so the tests can assert the
// exact semantics manager.ts used to have (tolerant reads, .download handling,
// enabled-state preservation, verbatim error messages and progress labels).

const DATA = "D:\\data";

// ── fakes ────────────────────────────────────────────────────────────────────

class FakeLedger implements SubscriptionLedgerStore {
  store: Record<string, Subscription> = {};
  saves: Record<string, Subscription>[] = [];
  /** Set to make every read report the stored ledger as quarantined (#64). */
  recovered: LedgerRead["recovered"];

  async load(): Promise<LedgerRead> {
    // A fresh object each time, like re-reading a JSON file.
    const subs: Record<string, Subscription> = JSON.parse(JSON.stringify(this.store));
    return this.recovered ? { subs, recovered: this.recovered } : { subs };
  }

  async save(subs: Record<string, Subscription>): Promise<void> {
    this.store = JSON.parse(JSON.stringify(subs));
    this.saves.push(this.store);
  }
}

class FakeDownloader implements DownloadPort {
  calls: { url: string; dest: string; token?: string }[] = [];
  /** Content written per downloaded file; keyed by url, default the url itself. */
  content = new Map<string, string>();
  /** Progress fractions to report per download (when a callback is given). */
  fractions: number[] = [];

  constructor(private readonly fs: MemFileSystem) {}

  async download(
    url: string,
    dest: string,
    token?: string,
    onProgress?: (f: number) => void,
  ): Promise<void> {
    this.calls.push({ url, dest, token });
    if (onProgress) for (const f of this.fractions) onProgress(f);
    this.fs.seedFile(dest, this.content.get(url) ?? url);
  }
}

class FakeArchive implements ArchivePort {
  cmd: string | null = "7z";
  extracts: { archive: string; outDir: string }[] = [];
  /** Files (relative to outDir) the fake "unpacks" on extract. */
  unpacked = new Map<string, string>();
  /** Set to make extract fail the way 7-Zip does on a truncated volume. */
  extractFails: string | undefined;

  constructor(private readonly fs: MemFileSystem) {}

  async available(): Promise<string | null> {
    return this.cmd;
  }
  async extract(archive: string, outDir: string): Promise<void> {
    this.extracts.push({ archive, outDir });
    if (this.extractFails) throw new Error(this.extractFails);
    for (const [rel, content] of this.unpacked) this.fs.seedFile(path.join(outDir, rel), content);
  }
  async packagePayload(): Promise<never> {
    throw new Error("not used by the subscription service");
  }
}

class FakeLinker implements LinkerPort {
  enables: { id: string; src: string; dest: string }[][] = [];
  disables: { id: string; installedPath: string }[][] = [];
  result: LinkResult | undefined;
  /** Link ids the fake cannot remove, with the reason it reports for each. */
  undeletable = new Map<string, string>();

  async enable(defs: { id: string; src: string; dest: string }[]): Promise<LinkResult> {
    this.enables.push(defs);
    return (
      this.result ?? {
        ok: true,
        created: defs.map((d) => ({ id: d.id, src: d.src, dest: d.dest })),
      }
    );
  }
  disable(installed: { id: string; installedPath: string }[]): DisableResult {
    this.disables.push(installed);
    const removed: string[] = [];
    const failed: { id: string; message: string }[] = [];
    for (const l of installed) {
      const reason = this.undeletable.get(l.id);
      if (reason === undefined) removed.push(l.id);
      else failed.push({ id: l.id, message: reason });
    }
    return { removed, failed };
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
  const mem = new MemFileSystem();
  const fs = new RecordingFileSystem(mem);
  const ledger = new FakeLedger();
  const downloader = new FakeDownloader(mem);
  const archive = new FakeArchive(mem);
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
    mem,
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
// Extraction lands here and is renamed onto MOD_DIR only once it succeeded.
const STAGING = `${MOD_DIR}.unpacking`;
// Where the outgoing payload waits while the incoming one takes its place, so
// that a failed rename can put it back instead of having deleted it already.
const PREVIOUS = `${MOD_DIR}.previous`;
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

  it("carries the ledger's recovery notice out with the list", async () => {
    // An unreadable ledger reads as an EMPTY one, so a caller that only sees
    // the list is about to claim nothing is installed while the links are
    // still in the user's DCS folders. The notice used to be a one-shot flag
    // on the adapter, drained by whoever asked first (#64); it now travels
    // with the read that produced it, so it cannot reach the wrong caller and
    // cannot go missing when two panels are open.
    const w = makeWorld();
    w.ledger.recovered = { quarantinedTo: "D:\\data\\subscriptions.json.corrupt" };

    const read = await w.service.listWithRecovery();

    expect(read.mods).toEqual([]);
    expect(read.recovered).toEqual({ quarantinedTo: "D:\\data\\subscriptions.json.corrupt" });
  });

  it("omits the notice entirely when the ledger read cleanly", async () => {
    // Absent rather than undefined-valued: `recovered` present at all is the
    // signal, so the callers can branch on the key.
    const w = makeWorld();
    w.ledger.store = { "a/a": seeded({ repo: "a/a", name: "Alpha" }) };

    const read = await w.service.listWithRecovery();

    expect(read.mods.map((m) => m.name)).toEqual(["Alpha"]);
    expect("recovered" in read).toBe(false);
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
    expect(w.mem.hasFile(tmp)).toBe(false);
    expect(w.fs.pathsFor("remove")).toContain(tmp);
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
    // It unpacks into the staging sibling, which is then renamed into place.
    expect(w.archive.extracts).toEqual([
      { archive: path.join(DL_DIR, "big.7z.001"), outDir: STAGING },
    ]);
    // The outgoing payload is moved aside first and only binned once the
    // incoming one is in place, so the swap is two renames, never a delete.
    expect(w.fs.argsFor("move")).toEqual([
      [MOD_DIR, PREVIOUS],
      [STAGING, MOD_DIR],
    ]);
    // The .download dir is cleaned up afterwards.
    expect(w.fs.pathsFor("remove")).toContain(DL_DIR);

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

  it("replaces prior unpacked content with the staged payload once extraction succeeds", async () => {
    const w = makeWorld();
    w.mem.seedDir(MOD_DIR);
    w.mem.seedFile(path.join(MOD_DIR, "old-file.lua"), "stale");
    w.mem.seedDir(path.join(MOD_DIR, "old-dir"));
    w.archive.unpacked.set("new-file.lua", "fresh");

    await w.service.subscribe(target(), undefined, w.onProgress);

    expect(w.mem.hasFile(path.join(MOD_DIR, "old-file.lua"))).toBe(false);
    expect(w.mem.hasDir(path.join(MOD_DIR, "old-dir"))).toBe(false);
    expect(w.mem.read(path.join(MOD_DIR, "new-file.lua"))).toBe("fresh");
    // Nothing is left at the staging path once it has been renamed into place.
    expect(w.mem.hasFile(path.join(STAGING, "new-file.lua"))).toBe(false);
    expect(w.mem.hasDir(STAGING)).toBe(false);
  });

  it("leaves the previous install and its ledger entry untouched when extraction fails", async () => {
    // The dangerous case: re-installing over a mod that currently works. If the
    // archive is truncated or the disk is full, the files that ARE working must
    // still be there and the ledger must still describe them truthfully.
    const w = makeWorld();
    const links = [{ id: "Owner/Repo:0", dest: "C:\\SG\\DCS\\Scripts\\X" }];
    w.ledger.store = { "owner/repo": seeded({ tag: "v1.0.0", enabled: true, links }) };
    w.mem.seedDir(MOD_DIR);
    w.mem.seedFile(path.join(MOD_DIR, "Scripts", "X"), "working payload");
    w.archive.extractFails = "7-Zip exited 2: Unexpected end of archive";

    await expect(
      w.service.subscribe(target({ tag: "v2.0.0" }), undefined, w.onProgress),
    ).rejects.toThrow("7-Zip exited 2: Unexpected end of archive");

    expect(w.mem.read(path.join(MOD_DIR, "Scripts", "X"))).toBe("working payload");
    expect(w.fs.argsFor("move")).toEqual([]);
    expect(w.fs.pathsFor("remove")).toContain(STAGING); // the half-written staging copy
    expect(w.fs.pathsFor("remove")).not.toContain(MOD_DIR);
    // Still recorded as installed and enabled at the tag whose files are on disk.
    expect(w.ledger.saves).toEqual([]);
    expect(w.ledger.store["owner/repo"]).toMatchObject({ tag: "v1.0.0", enabled: true, links });
  });

  it("keeps the working install when the swap into place fails", async () => {
    // The case that used to lose everything. The old order was remove(dir) then
    // move(staging, dir), with a catch that removed staging — so a failed swap
    // deleted the old payload and then the new one, leaving nothing on disk
    // while the ledger still recorded the mod as installed and enabled with
    // links into a directory that no longer existed.
    //
    // It is not an exotic failure: renaming a directory on Windows fails with
    // EPERM/EBUSY whenever anything holds a handle under it, and updating a mod
    // while DCS is open is the ordinary way to hit that.
    const w = makeWorld();
    const links = [{ id: "Owner/Repo:0", dest: "C:\\SG\\DCS\\Scripts\\X" }];
    w.ledger.store = { "owner/repo": seeded({ tag: "v1.0.0", enabled: true, links }) };
    w.mem.seedDir(MOD_DIR);
    w.mem.seedFile(path.join(MOD_DIR, "Scripts", "X"), "working payload");
    // Only the swap itself fails: moving the old payload aside, and putting it
    // back, both succeed — which is the whole point of doing it in that order.
    w.fs.failOn("move", "EPERM: operation not permitted, rename", STAGING);

    await expect(
      w.service.subscribe(target({ tag: "v2.0.0" }), undefined, w.onProgress),
    ).rejects.toThrow("EPERM: operation not permitted, rename");

    // The v1.0.0 payload is back where the ledger says it is.
    expect(w.mem.read(path.join(MOD_DIR, "Scripts", "X"))).toBe("working payload");
    expect(w.ledger.saves).toEqual([]);
    expect(w.ledger.store["owner/repo"]).toMatchObject({ tag: "v1.0.0", enabled: true, links });
    // And the staged v2.0.0 copy was never deleted while the live directory was
    // empty — at no point were both copies gone at once.
    // Once, to clear the fixed name before extracting — never again. The second
    // remove is the one that used to delete the last copy in existence.
    expect(w.fs.pathsFor("remove").filter((p) => p === STAGING)).toHaveLength(1);
    expect(w.fs.argsFor("move")).toEqual([
      [MOD_DIR, PREVIOUS],
      [STAGING, MOD_DIR],
      [PREVIOUS, MOD_DIR],
    ]);
  });

  it("completes the update when only the cleanup of the old payload fails", async () => {
    // The swap SUCCEEDED here: dir holds v2.0.0 and .previous is a copy nobody
    // needs. Letting that delete propagate would report a failure for an update
    // that happened — subscribe would never reach ledger.save, so My Mods would
    // show v1.0.0 while the links resolve into a directory serving v2.0.0. The
    // user is told it failed and DCS loads the new files anyway, which is worse
    // than the failure being reported.
    //
    // It is also the likely delete to fail: .previous is the directory DCS was
    // reading from until one rename ago, so a surviving handle under it is what
    // a recursive delete on Windows expects to meet.
    const w = makeWorld();
    w.ledger.store = { "owner/repo": seeded({ tag: "v1.0.0", enabled: true, links: [] }) };
    w.mem.seedDir(MOD_DIR);
    w.mem.seedFile(path.join(MOD_DIR, "Scripts", "X"), "working payload");
    w.archive.unpacked.set("Scripts/X", "v2 payload");
    // The SECOND remove of .previous — the cleanup after a successful swap.
    // The first clears a leftover before anything has moved, and failing there
    // is a real error worth propagating: the move aside would fail next anyway,
    // with a worse message.
    w.fs.failOn("remove", "EPERM: operation not permitted, rmdir", PREVIOUS, 1);

    await expect(
      w.service.subscribe(target({ tag: "v2.0.0" }), undefined, w.onProgress),
    ).resolves.not.toThrow();

    // Disk and ledger agree, which is the whole point.
    expect(w.mem.read(path.join(MOD_DIR, "Scripts", "X"))).toBe("v2 payload");
    expect(w.ledger.store["owner/repo"]).toMatchObject({ tag: "v2.0.0" });
    expect(w.ledger.saves).toHaveLength(1);
  });

  it("leaves everything as it was when the old payload cannot be moved aside", async () => {
    // Nothing has moved yet at that point, so propagating is correct — the live
    // payload is untouched and the staged copy is still there for a retry. It
    // is asserted rather than assumed because "correct by inspection" is what
    // the original swap bug was too.
    const w = makeWorld();
    const links = [{ id: "Owner/Repo:0", dest: "C:\\SG\\DCS\\Scripts\\X" }];
    w.ledger.store = { "owner/repo": seeded({ tag: "v1.0.0", enabled: true, links }) };
    w.mem.seedDir(MOD_DIR);
    w.mem.seedFile(path.join(MOD_DIR, "Scripts", "X"), "working payload");
    w.fs.failOn("move", "EPERM: operation not permitted, rename", MOD_DIR);

    await expect(
      w.service.subscribe(target({ tag: "v2.0.0" }), undefined, w.onProgress),
    ).rejects.toThrow("EPERM: operation not permitted, rename");

    expect(w.mem.read(path.join(MOD_DIR, "Scripts", "X"))).toBe("working payload");
    expect(w.ledger.saves).toEqual([]);
    expect(w.ledger.store["owner/repo"]).toMatchObject({ tag: "v1.0.0", enabled: true, links });
    // The move was attempted and nothing followed it.
    expect(w.fs.argsFor("move")).toEqual([[MOD_DIR, PREVIOUS]]);
  });

  it("names both copies when the previous payload cannot be put back either", async () => {
    // Both renames failing leaves the live directory empty with two complete
    // payloads beside it. Neither is deleted; the recovery is a manual rename,
    // which nobody can perform without being told the two names.
    const w = makeWorld();
    w.ledger.store = { "owner/repo": seeded({ tag: "v1.0.0", enabled: true, links: [] }) };
    w.mem.seedDir(MOD_DIR);
    w.mem.seedFile(path.join(MOD_DIR, "Scripts", "X"), "working payload");
    w.fs.failOn("move", "EPERM: operation not permitted, rename", STAGING);
    w.fs.failOn("move", "EPERM: operation not permitted, rename", PREVIOUS);

    const err = await w.service.subscribe(target({ tag: "v2.0.0" }), undefined, w.onProgress).then(
      () => new Error("expected the swap to fail"),
      (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
    );

    expect(err.message).toContain(PREVIOUS);
    expect(err.message).toContain(STAGING);
    expect(err.message).toContain("EPERM: operation not permitted, rename");
    // Once, clearing the fixed name before the swap begins. Nothing removes
    // either copy afterwards — both are named in the message instead.
    expect(w.fs.pathsFor("remove").filter((p) => p === PREVIOUS)).toHaveLength(1);
    expect(w.fs.pathsFor("remove").filter((p) => p === STAGING)).toHaveLength(1);
    expect(w.ledger.saves).toEqual([]);
  });

  it("clears a staging folder left behind by an interrupted install", async () => {
    // A fixed staging name means the next attempt starts from a clean slate
    // instead of extracting on top of a half-unpacked previous try.
    const w = makeWorld();
    w.mem.seedDir(STAGING);
    w.mem.seedFile(path.join(STAGING, "half-written.lua"), "junk");

    await w.service.subscribe(target(), undefined, w.onProgress);

    expect(w.mem.hasFile(path.join(MOD_DIR, "half-written.lua"))).toBe(false);
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

  // Issue #16: the snapshot is what every later action reads, so a manifest
  // declaring a path outside its root must never become a ledger entry — that
  // entry is what would let My Mods launch the exe or the aggregator dofile the
  // script, neither of which needs the mod to be enabled first.
  it("refuses to record a mod whose manifest reaches outside the DCS roots", async () => {
    const w = makeWorld();
    const hostile: ManifestModel = {
      ...MODEL,
      symlink: [{ source: "Scripts/X", dest: "{SavedGames}/notes.txt:hidden" }],
    };
    w.archive.unpacked.set("dcs-studio.toml", JSON.stringify(hostile));

    await expect(w.service.subscribe(target(), undefined, w.onProgress)).rejects.toThrow(
      "This mod's manifest asks to write outside your DCS folders.",
    );
    expect(w.ledger.store).toEqual({});
    expect(w.ledger.saves).toEqual([]);
  });

  it("refuses a mod whose entrypoint exe escapes the unpacked folder", async () => {
    const w = makeWorld();
    const hostile: ManifestModel = {
      ...MODEL,
      entrypoint: [{ id: "x", name: "X", exe: "../../Windows/System32/cmd.exe" }],
    };
    w.archive.unpacked.set("dcs-studio.toml", JSON.stringify(hostile));

    await expect(w.service.subscribe(target(), undefined, w.onProgress)).rejects.toThrow(
      'Executable "../../Windows/System32/cmd.exe" reaches outside the mod\'s own folder.',
    );
    expect(w.ledger.store).toEqual({});
  });

  it("refuses a mod whose mission script escapes the unpacked folder", async () => {
    const w = makeWorld();
    const hostile: ManifestModel = {
      ...MODEL,
      mission_script: [{ name: "L", path: "../../evil.lua", run_on: "before-sanitize" }],
    };
    w.archive.unpacked.set("dcs-studio.toml", JSON.stringify(hostile));

    await expect(w.service.subscribe(target(), undefined, w.onProgress)).rejects.toThrow(
      'Mission script "../../evil.lua" reaches outside the mod\'s own folder.',
    );
    expect(w.ledger.store).toEqual({});
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
  w.mem.seedFile(path.join(MOD_DIR, "dcs-studio.toml"), JSON.stringify(MODEL));
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
    w.mem.seedFile(path.join(MOD_DIR, "dcs-studio.toml"), JSON.stringify(model));

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

  // Issue #16: enable re-reads the manifest off disk, so it re-checks it. A
  // ledger written before the guard existed, or a manifest replaced under an
  // already-subscribed mod, must not reach the linker.
  it("refuses a manifest whose dest walks out of the DCS roots, before linking", async () => {
    const w = makeWorld();
    const model = {
      ...MODEL,
      symlink: [{ source: "Scripts/X", dest: "{SavedGames}/../../Windows/System32/evil.dll" }],
    };
    w.ledger.store = { "owner/repo": seeded() };
    w.mem.seedFile(path.join(MOD_DIR, "dcs-studio.toml"), JSON.stringify(model));

    await expect(w.service.enable("Owner/Repo")).rejects.toThrow(
      'Link destination "{SavedGames}/../../Windows/System32/evil.dll" reaches outside the configured DCS folders.',
    );
    expect(w.linker.enables).toEqual([]);
    expect(w.ledger.saves).toEqual([]);
    expect(w.ledger.store["owner/repo"].enabled).toBe(false);
  });

  it("refuses a manifest whose source walks out of the unpacked folder", async () => {
    const w = makeWorld();
    const model = {
      ...MODEL,
      symlink: [{ source: "../../Windows/System32", dest: "{SavedGames}/Scripts/X" }],
    };
    w.ledger.store = { "owner/repo": seeded() };
    w.mem.seedFile(path.join(MOD_DIR, "dcs-studio.toml"), JSON.stringify(model));

    await expect(w.service.enable("Owner/Repo")).rejects.toThrow(
      'Link source "../../Windows/System32" reaches outside the mod\'s own folder.',
    );
    expect(w.linker.enables).toEqual([]);
  });

  it("refuses an on-disk manifest lacking the newer sections without tripping over them", async () => {
    // The optional-section defaulting in the containment check has to survive an
    // older payload, or the guard itself becomes the failure.
    const w = makeWorld();
    const old = {
      project: MODEL.project,
      bundle: [],
      symlink: [{ source: "Scripts/X", dest: "{SavedGames}/Scripts/X" }],
      requires_module: [],
      extras: [],
    };
    w.ledger.store = { "owner/repo": seeded() };
    w.mem.seedFile(path.join(MOD_DIR, "dcs-studio.toml"), JSON.stringify(old));

    await w.service.enable("Owner/Repo");
    expect(w.ledger.store["owner/repo"].enabled).toBe(true);
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

  it("keeps a link it could not remove, stays enabled, and names what survived", async () => {
    // DCS holding a link open is the everyday case. Reporting a clean disable
    // would drop the surviving link from the ledger — and from the escape hatch
    // that exists precisely for a link the extension cannot remove itself.
    const w = makeWorld();
    const links = [
      { id: "Owner/Repo:0", dest: "C:\\SG\\DCS\\Scripts\\X" },
      { id: "Owner/Repo:1", dest: "C:\\SG\\DCS\\Mods\\Y" },
    ];
    w.ledger.store = { "owner/repo": seeded({ enabled: true, links }) };
    w.linker.undeletable.set("Owner/Repo:1", "EBUSY: resource busy or locked");

    await expect(w.service.disable("Owner/Repo")).rejects.toThrow(
      "1 of 2 link(s) could not be removed — close DCS and try again. " +
        "Still linked: C:\\SG\\DCS\\Mods\\Y (EBUSY: resource busy or locked)",
    );

    const saved = w.ledger.store["owner/repo"];
    expect(saved.enabled).toBe(true); // a link remains, so it is not disabled
    expect(saved.links).toEqual([{ id: "Owner/Repo:1", dest: "C:\\SG\\DCS\\Mods\\Y" }]);
    // The clean-uninstall script still removes what is still on disk.
    expect(renderUninstallScript(w.ledger.store, DATA, "subs.json")).toContain(
      "C:\\SG\\DCS\\Mods\\Y",
    );
  });

  it("finishes the job on a retry once the link can be removed", async () => {
    const w = makeWorld();
    const links = [{ id: "Owner/Repo:0", dest: "C:\\SG\\DCS\\Scripts\\X" }];
    w.ledger.store = { "owner/repo": seeded({ enabled: true, links }) };
    w.linker.undeletable.set("Owner/Repo:0", "EBUSY: resource busy or locked");
    await expect(w.service.disable("Owner/Repo")).rejects.toThrow("1 of 1 link(s)");

    w.linker.undeletable.clear(); // DCS closed
    await w.service.disable("Owner/Repo");

    expect(w.ledger.store["owner/repo"]).toMatchObject({ enabled: false, links: [] });
    expect(w.linker.disables[1]).toEqual([
      { id: "Owner/Repo:0", installedPath: "C:\\SG\\DCS\\Scripts\\X" },
    ]);
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

    const before = w.mem.read(BEFORE_AGG)!;
    const after = w.mem.read(AFTER_AGG)!;
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

    const after = w.mem.read(AFTER_AGG)!;
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

    const before = w.mem.read(BEFORE_AGG)!;
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

    const after = w.mem.read(AFTER_AGG)!;
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

  it("abandons the update when a link could not be removed first", async () => {
    // Downloading over files something else is still holding open is how a
    // working install becomes a broken one.
    const w = makeWorld();
    const links = [{ id: "Owner/Repo:0", dest: "C:\\SG\\DCS/Scripts/X" }];
    w.ledger.store = { "owner/repo": seeded({ tag: "v1.0.0", enabled: true, links }) };
    w.linker.undeletable.set("Owner/Repo:0", "EBUSY: resource busy or locked");

    await expect(
      w.service.update(target({ tag: "v2.0.0" }), undefined, w.onProgress),
    ).rejects.toThrow("1 of 1 link(s) could not be removed");

    expect(w.downloader.calls).toEqual([]);
    expect(w.archive.extracts).toEqual([]);
    expect(w.ledger.store["owner/repo"].tag).toBe("v1.0.0");
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
    expect(w.fs.pathsFor("remove")).toEqual([]);
  });

  it("removes links (when enabled), deletes the unpacked dir, and drops the ledger entry", async () => {
    const w = makeWorld();
    const links = [{ id: "Owner/Repo:0", dest: "C:\\SG\\DCS\\Scripts\\X" }];
    w.ledger.store = { "owner/repo": seeded({ enabled: true, links }) };

    await w.service.unsubscribe("OWNER/REPO"); // case-insensitive

    expect(w.linker.disables).toEqual([
      [{ id: "Owner/Repo:0", installedPath: "C:\\SG\\DCS\\Scripts\\X" }],
    ]);
    expect(w.fs.pathsFor("remove")).toContain(MOD_DIR);
    expect(w.ledger.store).toEqual({});
  });

  it("keeps everything when a link could not be removed, and says what to do", async () => {
    // Uninstalling while DCS is running is ordinary, and DCS holds its loaded
    // files open — so a surviving link is the expected failure. Dropping the
    // entry anyway would lose the record of what is still in the user's DCS,
    // including from uninstall-all.bat, which exists for exactly this.
    const w = makeWorld();
    const links = [
      { id: "Owner/Repo:0", dest: "C:\\SG\\DCS\\Scripts\\X" },
      { id: "Owner/Repo:1", dest: "C:\\SG\\DCS\\Mods\\Y" },
    ];
    w.ledger.store = { "owner/repo": seeded({ enabled: true, links }) };
    w.linker.undeletable.set("Owner/Repo:1", "EBUSY: resource busy or locked");

    await expect(w.service.unsubscribe("Owner/Repo")).rejects.toThrow(
      "1 of 2 link(s) could not be removed — close DCS and try again. " +
        "Still linked: C:\\SG\\DCS\\Mods\\Y (EBUSY: resource busy or locked)",
    );

    const saved = w.ledger.store["owner/repo"];
    expect(saved.enabled).toBe(true); // a link of ours is still in their DCS
    expect(saved.links).toEqual([{ id: "Owner/Repo:1", dest: "C:\\SG\\DCS\\Mods\\Y" }]);
    // The payload stays too: deleting it would leave that surviving link
    // pointing at nothing, which is worse than a mod that is still installed.
    expect(w.fs.pathsFor("remove")).not.toContain(MOD_DIR);
  });

  it("completes on a retry once the link is free", async () => {
    // The half-uninstalled state has to be one a second attempt can finish.
    const w = makeWorld();
    const links = [{ id: "Owner/Repo:0", dest: "C:\\SG\\DCS\\Scripts\\X" }];
    w.ledger.store = { "owner/repo": seeded({ enabled: true, links }) };
    w.linker.undeletable.set("Owner/Repo:0", "EBUSY: resource busy or locked");
    await expect(w.service.unsubscribe("Owner/Repo")).rejects.toThrow("could not be removed");

    w.linker.undeletable.clear(); // the user closed DCS
    await w.service.unsubscribe("Owner/Repo");

    expect(w.ledger.store).toEqual({});
    expect(w.fs.pathsFor("remove")).toContain(MOD_DIR);
  });

  it("skips the linker for a disabled subscription but still deletes and drops it", async () => {
    const w = makeWorld();
    w.ledger.store = { "owner/repo": seeded({ enabled: false }) };

    await w.service.unsubscribe("Owner/Repo");

    expect(w.linker.disables).toEqual([]);
    expect(w.fs.pathsFor("remove")).toContain(MOD_DIR);
    expect(w.ledger.store).toEqual({});
  });
});
