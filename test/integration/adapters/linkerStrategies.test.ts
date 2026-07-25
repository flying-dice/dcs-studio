import type * as fsTypes from "node:fs";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpawnHarness, type SpawnHarness } from "../../support/fakeChildProcess";

// The Windows half of the linker, plus the failure paths.
//
// test/integration/install/linker.test.ts covers what the linker *decides* —
// merge, adopt, enter, conflict, rollback — against a real filesystem on
// whatever host the suite runs on. What it cannot reach is the branch that only
// exists on Windows: a directory becomes a junction, a same-volume file becomes
// a hard link, and a cross-volume file becomes a symlink, which unprivileged
// Windows refuses with EPERM and the adapter then retries behind a UAC prompt.
// That last path is the one users actually hit — DCS on D: with the data dir on
// C: is a completely ordinary setup — and getting the PowerShell quoting wrong
// there silently links the wrong path, or nothing at all.
//
// So `platform()` is faked and the syscalls stay real: Node ignores the link
// *type* argument off Windows, so a junction request really creates a link and a
// hard link really shares an inode. Only EPERM, which cannot be provoked on
// demand, is injected — and "different volumes" is expressed with a UNC-shaped
// path, which win32 path parsing reads as a different root while Linux still
// resolves it to the same file.

let spawner: SpawnHarness;
let hostPlatform = "linux";
/** Injected symlink failure, keyed on the link path so setup stays unaffected. */
let symlinkFault: ((link: string) => void) | null = null;
/** Injected removal failure, for the "not even an Error" path. */
let rmFault: ((target: string) => void) | null = null;

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof os>()),
  platform: () => hostPlatform,
}));

vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) =>
    spawner.spawn(cmd, args, opts),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fsTypes>();
  return {
    ...actual,
    symlinkSync: (
      target: fsTypes.PathLike,
      link: fsTypes.PathLike,
      type?: fsTypes.symlink.Type | null,
    ) => {
      symlinkFault?.(String(link));
      return actual.symlinkSync(target, link, type);
    },
    rmSync: (target: fsTypes.PathLike, options?: fsTypes.RmOptions) => {
      rmFault?.(String(target));
      return actual.rmSync(target, options);
    },
  };
});

import { Linker, mklink } from "../../../src/adapters/node/linker";

let root: string;
let src: string;
let dest: string;

/**
 * The same file, addressed so `path.win32.parse` sees a different volume root —
 * which is what `sameVolume()` compares, and therefore what sends the adapter
 * down the cross-volume branch.
 *
 * A second real volume cannot be conjured on either CI host, so this fabricates
 * the spelling instead, and the spelling has to differ per host because it must
 * ALSO still resolve to the file for the real symlink/lstat calls below:
 *
 * - off Windows, a leading slash — `//tmp/x` is the same file as `/tmp/x` to
 *   POSIX, while win32 parsing reads `//tmp/x` as its own UNC-ish root;
 * - on Windows, the extended-length prefix — `\\?\C:\x` is the same file to
 *   the Win32 API, and parses with root `\\?\C:\` rather than `C:\`.
 *   (`/C:\x` was the old spelling and does neither: Windows resolves it
 *    against the current drive, producing `D:\C:\x`, which does not exist.)
 */
const otherVolume = (p: string) => (process.platform === "win32" ? `\\\\?\\${p}` : `/${p}`);

beforeEach(() => {
  spawner = createSpawnHarness();
  hostPlatform = "linux";
  symlinkFault = null;
  rmFault = null;
  root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "dcs-linker-"));
  src = path.join(root, "data");
  dest = path.join(root, "dcs");
  nodeFs.mkdirSync(src, { recursive: true });
  nodeFs.mkdirSync(dest, { recursive: true });
});

afterEach(() => {
  // Clear the faults before cleanup, or the temp-dir removal trips them too.
  symlinkFault = null;
  rmFault = null;
  nodeFs.rmSync(root, { recursive: true, force: true });
});

function file(rel: string, content = "payload"): string {
  const p = path.join(src, rel);
  nodeFs.mkdirSync(path.dirname(p), { recursive: true });
  nodeFs.writeFileSync(p, content);
  return p;
}

function dir(rel: string): string {
  const p = path.join(src, rel);
  nodeFs.mkdirSync(p, { recursive: true });
  nodeFs.writeFileSync(path.join(p, "inner.lua"), "payload");
  return p;
}

describe("mklink refuses to clobber", () => {
  it("declines when something is already at the link path", async () => {
    // The caller's own conflict checks run first, so reaching here means a race
    // or a stale ledger — either way, overwriting a user's file is unacceptable.
    const target = file("mod.lua");
    const link = path.join(dest, "mod.lua");
    nodeFs.writeFileSync(link, "theirs");

    expect(await mklink(link, target)).toEqual({
      ok: false,
      message: `Link path already exists: ${link}`,
    });
    expect(nodeFs.readFileSync(link, "utf8")).toBe("theirs");
  });
});

describe("mklink off Windows", () => {
  it("reports a symlink that could not be created", async () => {
    const target = file("mod.lua");
    const link = path.join(root, "missing-parent", "mod.lua");
    const r = await mklink(link, target);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/^Failed to create symbolic link: /);
  });
});

describe("mklink on Windows", () => {
  beforeEach(() => {
    hostPlatform = "win32";
  });

  it("links a directory as a junction, which needs no elevation", async () => {
    // Junctions are why enabling a mod's folders does not prompt for admin;
    // switching them to symlinks would make every enable require UAC.
    const target = dir("Hooks");
    const link = path.join(dest, "Hooks");
    expect(await mklink(link, target)).toEqual({ ok: true });
    expect(nodeFs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(nodeFs.readFileSync(path.join(link, "inner.lua"), "utf8")).toBe("payload");
  });

  it("reports a junction that could not be created", async () => {
    const target = dir("Hooks");
    const r = await mklink(path.join(root, "missing-parent", "Hooks"), target);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/^Failed to create junction: /);
  });

  it("hard-links a file that lives on the same volume", async () => {
    // A hard link needs no elevation and survives the data dir being moved
    // within the volume; the file is genuinely one file, not a copy.
    const target = file("mod.lua");
    const link = path.join(dest, "mod.lua");
    expect(await mklink(link, target)).toEqual({ ok: true });
    expect(nodeFs.lstatSync(link).isSymbolicLink()).toBe(false);
    expect(nodeFs.statSync(link).ino).toBe(nodeFs.statSync(target).ino);
  });

  it("reports a hard link that could not be created", async () => {
    const target = file("mod.lua");
    const r = await mklink(path.join(root, "missing-parent", "mod.lua"), target);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/^Failed to create hard link: /);
  });

  it("symlinks a file across volumes when the user may already do so", async () => {
    // Developer Mode (or an admin session) makes symlink creation permitted;
    // no UAC prompt should appear in that case.
    const target = file("mod.lua");
    const link = otherVolume(path.join(dest, "mod.lua"));
    expect(await mklink(link, target)).toEqual({ ok: true });
    expect(nodeFs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(spawner.calls).toEqual([]);
  });

  it("reports a cross-volume symlink failure that elevation would not fix", async () => {
    // Only EPERM means "you lack the privilege"; anything else is a real
    // problem and prompting for admin would just waste the user's time.
    const target = file("mod.lua");
    const r = await mklink(otherVolume(path.join(root, "missing-parent", "mod.lua")), target);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/^Failed to create symbolic link: /);
    expect(spawner.calls).toEqual([]);
  });

  it("reports a cross-volume failure that was not even an Error", async () => {
    symlinkFault = () => {
      throw "kaboom";
    };
    const target = file("mod.lua");
    const r = await mklink(otherVolume(path.join(dest, "mod.lua")), target);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toBe("Failed to create symbolic link: kaboom");
  });
});

describe("cross-volume symlink elevation", () => {
  beforeEach(() => {
    hostPlatform = "win32";
    symlinkFault = () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    };
  });

  it("retries behind a UAC prompt and reports success", async () => {
    // DCS on D: with the data dir on C: is an ordinary install; without this
    // retry every such user would see "operation not permitted" and stop.
    spawner.plan(() => ({ code: 0 }));
    const target = file("mod.lua");
    const link = otherVolume(path.join(dest, "mod.lua"));

    expect(await mklink(link, target)).toEqual({ ok: true });
    expect(spawner.calls[0].cmd).toBe("powershell.exe");
    const command = spawner.calls[0].args[spawner.calls[0].args.length - 1];
    expect(command).toContain("-Verb RunAs");
    // The elevated child gets the same base flags as every other invocation.
    // It used to be missing -NonInteractive — on the one call with no console
    // to answer a prompt on — because this adapter kept its own flag list.
    expect(spawner.calls[0].args.slice(0, 4)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
    ]);
    expect(command).toContain(`@("-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass"`);
    expect(command).toContain("New-Item -ItemType SymbolicLink");
    expect(command).toContain(link);
    expect(command).toContain(target);
  });

  it("escapes single quotes so a path cannot break out of the PowerShell literal", async () => {
    // Mod folders carry author names; "Bob's Mods" would otherwise terminate
    // the quoted string and hand the rest of the path to PowerShell as code.
    spawner.plan(() => ({ code: 0 }));
    const target = file("Bob's Mods/mod.lua");
    const link = otherVolume(path.join(dest, "mod.lua"));

    expect(await mklink(link, target)).toEqual({ ok: true });
    const command = spawner.calls[0].args[spawner.calls[0].args.length - 1];
    // Doubled twice: once for the inner New-Item literal, and again because
    // that whole script is itself passed as a quoted argument to Start-Process.
    // Losing either round leaves an unbalanced quote and the link is never made.
    expect(command).toContain("Bob''''s Mods");
    expect(command).not.toContain("Bob's Mods");
  });

  it("reports what PowerShell said when the elevated attempt fails", async () => {
    spawner.plan(() => ({ code: 1, stderr: "  The operation was canceled by the user.  \n" }));
    const r = await mklink(otherVolume(path.join(dest, "mod.lua")), file("mod.lua"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toBe("The operation was canceled by the user.");
  });

  it("falls back to the exit code when the elevated attempt says nothing", async () => {
    spawner.plan(() => ({ code: 5 }));
    const r = await mklink(otherVolume(path.join(dest, "mod.lua")), file("mod.lua"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toBe("exit 5");
  });

  it("reports PowerShell being unavailable rather than hanging", async () => {
    spawner.plan(() => ({ error: new Error("spawn powershell.exe ENOENT") }));
    const r = await mklink(otherVolume(path.join(dest, "mod.lua")), file("mod.lua"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toBe("spawn powershell.exe ENOENT");
  });
});

describe("re-enabling a Windows hard link", () => {
  it("adopts the existing hard link instead of reporting a conflict", async () => {
    // On Windows a same-volume file link is a hard link, which lstat cannot
    // tell apart from an ordinary file — only the shared inode says it is
    // ours. Without that check every re-enable of a file rule on Windows would
    // fail with "Destination path already exists".
    hostPlatform = "win32";
    const target = file("mod.lua");
    const link = path.join(dest, "mod.lua");
    const defs = [{ id: "m:0", src: target, dest: link }];

    expect((await new Linker().enable(defs)).ok).toBe(true);
    expect(nodeFs.lstatSync(link).isSymbolicLink()).toBe(false);

    const again = await new Linker().enable(defs);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.created).toEqual([{ id: "m:0", src: target, dest: link }]);
    expect(nodeFs.readFileSync(link, "utf8")).toBe("payload");
  });
});

describe("enable failure paths", () => {
  it("treats a destination that resolves to nothing as a conflict, not as ours", async () => {
    // A junction left behind pointing at a deleted data dir: it is not a link
    // we can claim, and silently replacing it would destroy whatever the user
    // meant it to reference.
    const target = dir("Hooks");
    const link = path.join(dest, "Hooks");
    nodeFs.symlinkSync(path.join(root, "deleted"), link, "dir");

    const res = await new Linker().enable([{ id: "m:0", src: target, dest: link }]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toBe(`Destination path already exists: ${link}`);
  });

  it("reports a parent directory that cannot be created", async () => {
    // A DCS root that is actually a file (a mistyped Setup path) fails here
    // rather than somewhere deeper with an opaque ENOTDIR.
    const blocker = path.join(dest, "Scripts");
    nodeFs.writeFileSync(blocker, "not a directory");

    const res = await new Linker().enable([
      { id: "m:0", src: file("mod.lua"), dest: path.join(blocker, "Hooks", "mod.lua") },
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toMatch(/^Failed to create parent directory: /);
  });

  it("surfaces the link failure when the destination's parent is a broken link", async () => {
    // The parent lstats fine (it is a link), so nothing is created for it, and
    // the failure only shows up when the link itself is attempted.
    const parent = path.join(dest, "Hooks");
    nodeFs.symlinkSync(path.join(root, "gone"), parent, "dir");

    const res = await new Linker().enable([
      { id: "m:0", src: file("mod.lua"), dest: path.join(parent, "mod.lua") },
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toMatch(/^Failed to create symbolic link: /);
  });

  it("rolls back links whose path stopped existing partway through", async () => {
    // A manifest that links a folder and then something inside that folder:
    // undoing the outer link first makes the inner path vanish, so rollback
    // has to tolerate links that are already gone. Throwing here would abort
    // the rollback and leave the mod half-installed.
    const inner = dir("Hooks");
    const res = await new Linker().enable([
      { id: "m:0", src: inner, dest: path.join(dest, "Hooks") },
      { id: "m:1", src: file("extra.lua"), dest: path.join(dest, "Hooks", "extra.lua") },
      { id: "m:2", src: path.join(src, "missing"), dest: path.join(dest, "missing") },
    ]);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toBe(`Source path does not exist: ${path.join(src, "missing")}`);
    expect(nodeFs.existsSync(path.join(dest, "Hooks"))).toBe(false);
  });
});

describe("disable", () => {
  it("counts an already-absent link as removed", async () => {
    // Users delete files by hand and uninstall scripts run twice; a disable
    // that failed on a missing link would strand the mod as un-uninstallable.
    const res = new Linker().disable([
      { id: "m:0", installedPath: path.join(dest, "never-existed.lua") },
    ]);
    expect(res).toEqual({ removed: ["m:0"], failed: [] });
  });

  it("records a failure per link and still removes the others", async () => {
    // One unremovable link must not abandon the rest of the mod's links.
    //
    // The refusal is injected rather than provoked, for the reason this file's
    // header gives about EPERM: the real case is DCS holding a file open, which
    // no test can arrange, and the host-specific tricks that fail a removal do
    // not agree — a path under a regular file is ENOTDIR on POSIX and simply a
    // missing path to `rmSync(..., { force: true })` on Windows, which counts
    // as removed. What is under test is the per-link bookkeeping, not the OS.
    const good = path.join(dest, "good.lua");
    nodeFs.symlinkSync(file("mod.lua"), good, "file");
    const held = path.join(dest, "held.lua");
    nodeFs.writeFileSync(held, "in use by DCS");
    rmFault = (target) => {
      if (target === held) throw new Error("EBUSY: resource busy or locked");
    };

    const res = new Linker().disable([
      { id: "m:0", installedPath: good },
      { id: "m:1", installedPath: held },
    ]);
    expect(res.removed).toEqual(["m:0"]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].id).toBe("m:1");
    expect(res.failed[0].message).toMatch(/EBUSY/);
    // The link that could go, went — the failure did not abandon it.
    expect(nodeFs.existsSync(good)).toBe(false);
  });

  it("describes a removal failure that was thrown as something other than an Error", () => {
    // Uninstall reports the failed links back to the user; an object with no
    // `.message` would otherwise be shown as "undefined" next to the link id.
    const link = path.join(dest, "mod.lua");
    nodeFs.symlinkSync(file("mod.lua"), link, "file");
    rmFault = () => {
      throw "device is busy";
    };

    const res = new Linker().disable([{ id: "m:0", installedPath: link }]);
    expect(res.removed).toEqual([]);
    expect(res.failed).toEqual([{ id: "m:0", message: "device is busy" }]);
  });
});
