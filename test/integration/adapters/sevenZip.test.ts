import * as nodeFs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSpawnHarness,
  type SpawnCall,
  type SpawnHarness,
} from "../../support/fakeChildProcess";
import { tmpRoot } from "../../support/tmpDir";

// The 7-Zip adapter decides two things a user feels directly: whether mods can
// be installed at all (7-Zip discovery — the CLI is not bundled, so a wrong
// answer here is "install failed" with no explanation), and whether a published
// payload ships as one archive or a numbered volume set. The split decision is
// irreversible once a release is out: a payload packed into volumes that older
// clients cannot reassemble is a broken download for everyone who fetches it.
//
// The sizing rules themselves are pure (core/domain/archivePolicy) and the argv
// is pure (core/domain/cliArgs); what is left here is the discovery order, the
// on-disk volume housekeeping, and mapping a 7z failure to a message. So the
// filesystem is real (a temp tree) and only the 7z process is faked — a fake
// archiver that really writes files of the sizes a test needs, which is the
// only way to reach the split path without generating gigabytes.

let spawner: SpawnHarness;

vi.mock("child_process", () => ({
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) =>
    spawner.spawn(cmd, args, opts),
  spawnSync: (cmd: string, args: string[], opts: Record<string, unknown>) =>
    spawner.spawnSync(cmd, args, opts),
}));

// Two of the four discovery candidates are absolute Program Files paths probed
// with existsSync — so on a machine that really has 7-Zip installed, which the
// Windows CI runner does, every "nothing usable here" case would find the
// host's own copy and answer with it. The suite's whole point is that discovery
// order is decided by the scenario, not by the machine it runs on.
//
// Everything else about the filesystem stays real: these specs pack and split
// actual files, which is the only way to reach the volume-split path without
// generating gigabytes. Only the two well-known install locations are forced
// absent.
vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    default: real,
    existsSync: (p: Parameters<typeof real.existsSync>[0]) =>
      /7-Zip[\\/]7z\.exe$/i.test(String(p)) ? false : real.existsSync(p),
  };
});

import {
  cleanVolumeFamily,
  find7z,
  packagePayload,
  SevenZipArchive,
} from "../../../src/adapters/node/sevenZip";

const tmp = tmpRoot("dcs-7z-");

beforeEach(() => {
  spawner = createSpawnHarness();
});

/** The `-v<n>b` flag position differs between pack and split, so find the path. */
function archiveArg(call: SpawnCall): string {
  return call.args.find((a) => a.endsWith(".7z")) ?? "";
}

/** A fake 7z that really writes `size` bytes of archive where it was told to. */
function archiverWriting(size: number) {
  return (call: SpawnCall) => ({
    stdout: "Everything is Ok\n",
    code: 0,
    effect: () => nodeFs.writeFileSync(archiveArg(call), Buffer.alloc(size)),
  });
}

describe("find7z", () => {
  it("prefers a bare 7z on PATH and confirms it actually runs", () => {
    // A candidate on PATH is only usable if it starts: a stale shim entry that
    // fails to launch must not be reported as the archiver.
    spawner.planSync((c) => (c.cmd === "7z" ? { status: 0 } : { error: new Error("ENOENT") }));
    expect(find7z()).toBe("7z");
  });

  it("falls through to the next candidate when the first will not run", () => {
    spawner.planSync((c) => (c.cmd === "7za" ? { status: 0 } : { error: new Error("ENOENT") }));
    expect(find7z()).toBe("7za");
  });

  it("returns null when nothing on the machine is usable", () => {
    // This is what turns into "7-Zip not found — install 7-Zip" for the user.
    spawner.planSync(() => ({ error: new Error("ENOENT") }));
    expect(find7z()).toBeNull();
  });

  it("treats a candidate as unusable when probing it throws outright", () => {
    spawner.planSync(() => {
      throw new Error("EACCES");
    });
    expect(find7z()).toBeNull();
  });

  it("lets a configured path win over everything on PATH", () => {
    // dcsStudio.sevenZipPath exists so a user with a portable 7-Zip can point
    // at it; being overruled by a PATH entry would make the setting useless.
    const exe = tmp.join("7z.exe");
    nodeFs.writeFileSync(exe, "");
    spawner.planSync(() => ({ status: 0 }));
    expect(find7z(exe)).toBe(exe);
    // A path-shaped candidate is checked on disk, never launched.
    expect(spawner.syncCalls).toEqual([]);
  });

  it("ignores a configured path that no longer exists and keeps looking", () => {
    // Users move or uninstall 7-Zip; a stale setting must degrade to discovery
    // rather than break every install.
    spawner.planSync((c) => (c.cmd === "7z" ? { status: 0 } : { error: new Error("ENOENT") }));
    expect(find7z(tmp.join("gone", "7z.exe"))).toBe("7z");
  });

  it("accepts a configured bare command by launching it", () => {
    spawner.planSync((c) => (c.cmd === "my7z" ? { status: 0 } : { error: new Error("ENOENT") }));
    expect(find7z("my7z")).toBe("my7z");
  });
});

describe("cleanVolumeFamily", () => {
  it("does nothing when the output directory has never been created", () => {
    expect(() => cleanVolumeFamily(tmp.join("nope"), "base")).not.toThrow();
  });

  it("removes only the named family, leaving other releases' assets alone", () => {
    // Publish reuses one out dir across mods and tags; deleting a neighbour's
    // volumes would silently corrupt the other release's assets.
    const out = tmp.join("out");
    nodeFs.mkdirSync(out);
    for (const f of ["mine.7z", "mine.7z.001", "mine.7z.002", "theirs.7z", "manifest.toml"]) {
      nodeFs.writeFileSync(path.join(out, f), "x");
    }
    cleanVolumeFamily(out, "mine");
    expect(nodeFs.readdirSync(out).sort()).toEqual(["manifest.toml", "theirs.7z"]);
  });
});

describe("packagePayload", () => {
  it("packs a small payload as a single archive and reports its real size", async () => {
    const out = tmp.join("out");
    spawner.plan(archiverWriting(64));
    const res = await packagePayload("7z", tmp.path, ["mod"], out, "base", 1024);

    expect(res).toEqual({ volumes: [path.join(out, "base.7z")], totalBytes: 64, split: false });
    // One pass only: a payload under the limit must never be repacked.
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0].opts).toEqual({ cwd: tmp.path, windowsHide: true });
    expect(spawner.calls[0].args).toEqual([
      "a",
      "-t7z",
      "-mx=5",
      "-y",
      path.join(out, "base.7z"),
      "mod",
    ]);
  });

  it("creates the output directory and clears a previous packaging run", async () => {
    // Re-publishing the same tag after shrinking a payload would otherwise
    // leave orphan .002/.003 volumes that the release then ships.
    const out = tmp.join("out");
    nodeFs.mkdirSync(out, { recursive: true });
    nodeFs.writeFileSync(path.join(out, "base.7z.003"), "stale");
    spawner.plan(archiverWriting(64));

    const res = await packagePayload("7z", tmp.path, ["mod"], out, "base", 1024);
    expect(res.split).toBe(false);
    expect(nodeFs.readdirSync(out)).toEqual(["base.7z"]);
  });

  it("repacks into numbered volumes when one archive exceeds the limit", async () => {
    // The single-archive attempt is discarded, not shipped alongside the
    // volumes — a release carrying both would confuse the installer's
    // first-volume selection.
    const out = tmp.join("out");
    spawner.plan((call) =>
      call.args.some((a) => a.startsWith("-v"))
        ? {
            code: 0,
            effect: () => {
              nodeFs.writeFileSync(path.join(out, "base.7z.002"), Buffer.alloc(4));
              nodeFs.writeFileSync(path.join(out, "base.7z.001"), Buffer.alloc(8));
            },
          }
        : archiverWriting(32)(call),
    );

    const res = await packagePayload("7z", tmp.path, ["mod"], out, "base", 8);
    expect(res).toEqual({
      volumes: [path.join(out, "base.7z.001"), path.join(out, "base.7z.002")],
      totalBytes: 12,
      split: true,
    });
    expect(nodeFs.existsSync(path.join(out, "base.7z"))).toBe(false);
    expect(spawner.calls[1].args).toContain("-v8b");
  });

  it("defaults to the shared 1.5 GiB volume size when none is given", async () => {
    // The default is what publish actually uses; a payload of ordinary size
    // must stay a single archive under it.
    const out = tmp.join("out");
    spawner.plan(archiverWriting(2048));
    const res = await packagePayload("7z", tmp.path, ["mod"], out, "base");
    expect(res.split).toBe(false);
  });

  it("reports a 7z that never started, distinctly from one that failed", async () => {
    spawner.plan(() => ({ error: new Error("spawn 7z ENOENT") }));
    await expect(packagePayload("7z", tmp.path, ["mod"], tmp.join("o"), "b")).rejects.toThrow(
      "7z failed to start: spawn 7z ENOENT",
    );
  });

  it("reports 7z's own stderr when it exits non-zero", async () => {
    spawner.plan(() => ({ code: 2, stderr: "ERROR: Can not open output file\n" }));
    await expect(packagePayload("7z", tmp.path, ["mod"], tmp.join("o"), "b")).rejects.toThrow(
      "7z exited 2: ERROR: Can not open output file",
    );
  });

  it("still says something useful when 7z fails without printing anything", async () => {
    spawner.plan(() => ({ code: 255 }));
    await expect(packagePayload("7z", tmp.path, ["mod"], tmp.join("o"), "b")).rejects.toThrow(
      "7z exited 255: (no output)",
    );
  });
});

describe("SevenZipArchive", () => {
  it("resolves the archiver with no configured path supplier at all", async () => {
    spawner.planSync((c) => (c.cmd === "7z" ? { status: 0 } : { error: new Error("ENOENT") }));
    expect(await new SevenZipArchive().available()).toBe("7z");
  });

  it("treats a blank configured path as unset rather than as a candidate", async () => {
    // The setting defaults to "" and users clear it by blanking the field;
    // passing that through would make every discovery attempt fail on "".
    spawner.planSync((c) => (c.cmd === "7z" ? { status: 0 } : { error: new Error("ENOENT") }));
    expect(await new SevenZipArchive(() => "   ").available()).toBe("7z");
  });

  it("uses the configured path when the setting holds one", async () => {
    const exe = tmp.join("7z.exe");
    nodeFs.writeFileSync(exe, "");
    expect(await new SevenZipArchive(() => `  ${exe}  `).available()).toBe(exe);
  });

  it("reports no archiver as null so callers can prompt for an install", async () => {
    spawner.planSync(() => ({ error: new Error("ENOENT") }));
    expect(await new SevenZipArchive(() => undefined).available()).toBeNull();
  });

  it("extracts an archive family by pointing 7z at its first volume", async () => {
    spawner.planSync(() => ({ status: 0 }));
    spawner.plan(() => ({ code: 0 }));
    const outDir = tmp.join("unpacked");
    await new SevenZipArchive().extract("D:\\cache\\mod.7z.001", outDir);
    expect(spawner.calls[0].args).toEqual(["x", "-y", `-o${outDir}`, "D:\\cache\\mod.7z.001"]);
  });

  it("tells the user to install 7-Zip when extraction has no archiver", async () => {
    // The whole install flow dead-ends here, so the message has to name the fix.
    spawner.planSync(() => ({ error: new Error("ENOENT") }));
    await expect(new SevenZipArchive().extract("a.7z", "out")).rejects.toThrow(
      "7-Zip not found — install 7-Zip (7-zip.org) to install mods.",
    );
  });

  it("reports an extract that never started", async () => {
    spawner.planSync(() => ({ status: 0 }));
    spawner.plan(() => ({ error: new Error("EACCES") }));
    await expect(new SevenZipArchive().extract("a.7z", "out")).rejects.toThrow("7z: EACCES");
  });

  it("reports a corrupt or incomplete archive with 7z's own diagnosis", async () => {
    // A truncated download is the common cause; the user needs 7z's wording to
    // tell that apart from a missing sibling volume.
    spawner.planSync(() => ({ status: 0 }));
    spawner.plan(() => ({ code: 2, stderr: "ERROR: Unexpected end of archive\n" }));
    await expect(new SevenZipArchive().extract("a.7z", "out")).rejects.toThrow(
      "7z extract exited 2: ERROR: Unexpected end of archive",
    );
  });

  it("packages through the resolved archiver, with and without an explicit size", async () => {
    spawner.planSync(() => ({ status: 0 }));
    const out = tmp.join("out");
    spawner.plan(archiverWriting(64));

    const archive = new SevenZipArchive();
    expect(await archive.packagePayload(tmp.path, ["mod"], out, "base", 1024)).toMatchObject({
      split: false,
      totalBytes: 64,
    });
    expect(await archive.packagePayload(tmp.path, ["mod"], out, "base")).toMatchObject({
      split: false,
    });
  });

  it("refuses to package when no archiver is available", async () => {
    spawner.planSync(() => ({ error: new Error("ENOENT") }));
    await expect(
      new SevenZipArchive().packagePayload(tmp.path, ["mod"], "out", "b"),
    ).rejects.toThrow("7z not found.");
  });
});
