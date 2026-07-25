import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { win32 as path } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

import * as vscode from "vscode";
import {
  type BridgeFs,
  eject,
  ejectCommand,
  inject,
  injectCommand,
  nodeBridgeFs,
  resolveDll,
  useBridgeFs,
} from "../../../src/bridge/deploy";
import {
  builtDllPath,
  dllInstallPath,
  hookInstallPath,
  hookSourcePath,
  legacyInstallPaths,
  shippedDllPath,
} from "../../../src/core/domain/bridgeDeploy";
import {
  type BridgeFsOverrides,
  lockedError,
  type MappedBridgeFs,
  mappedBridgeFs,
} from "./mappedBridgeFs";

// Inject/eject writes into somebody's real DCS installation, so both the layout
// and the rollback matter: a DLL in the wrong place is never loaded, an old one
// left behind binds port 25569 and answers instead of the new bridge, and a
// failed eject leaves the extension's code inside DCS after it is gone.
//
// The happy paths run against a real filesystem (see mappedBridgeFs) so the
// files genuinely land on the paths the layout rules name. The failures worth
// covering all involve a DCS holding a DLL open, which no test can arrange, so
// those substitute one operation of that same filesystem.

const GUI_DLL = "dcs_studio_gui.dll";
const MISSION_DLL = "dcs_studio_mission.dll";
const EXT = "C:\\Users\\pilot\\.vscode\\extensions\\dcs-studio";
const WRITE_DIR = "D:\\Saved Games\\DCS";

let root: string;
let io: MappedBridgeFs;
let restore: () => void;

function context(): vscode.ExtensionContext {
  return { extensionUri: vscode.Uri.file(EXT) } as unknown as vscode.ExtensionContext;
}

/** Replace the filesystem seam, keeping the mapping but failing one operation. */
function failWith(over: BridgeFsOverrides): void {
  restore();
  io = mappedBridgeFs(root, over);
  restore = useBridgeFs(io);
}

beforeEach(() => {
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "bridge-deploy-"));
  io = mappedBridgeFs(root);
  restore = useBridgeFs(io);
  resetVscode({ config: { "dcsStudio.savedGamesPath": WRITE_DIR } });
  // A complete extension install: both prebuilt DLLs and the hook script.
  io.seed(shippedDllPath(EXT, GUI_DLL), "shipped-gui");
  io.seed(shippedDllPath(EXT, MISSION_DLL), "shipped-mission");
  io.seed(hookSourcePath(EXT), "-- hook");
});

afterEach(() => {
  restore();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the default filesystem", () => {
  it("is the real one, wired to node's own calls", () => {
    // The seam only exists for these specs; the extension itself must reach the
    // user's disk, and a stubbed-out default would silently install nothing.
    expect(nodeBridgeFs.existsSync).toBe(fs.existsSync);
    expect(nodeBridgeFs.copyFile).toBe(fs.promises.copyFile);
    expect(nodeBridgeFs.mkdir).toBe(fs.promises.mkdir);
    expect(nodeBridgeFs.rm).toBe(fs.promises.rm);
  });

  it("is restored when a substitution is undone", () => {
    const undo = useBridgeFs({} as BridgeFs);
    undo();
    // Otherwise one spec's fake filesystem leaks into the next one's.
    expect(resolveDll(context(), GUI_DLL)).toBe(shippedDllPath(EXT, GUI_DLL));
  });
});

describe("resolveDll", () => {
  it("falls back to the DLL shipped with the extension", () => {
    expect(resolveDll(context(), GUI_DLL)).toBe(shippedDllPath(EXT, GUI_DLL));
  });

  it("prefers a freshly built workspace DLL over the shipped one", () => {
    // Someone who just ran the build command has to get their own DLL, or every
    // bridge change they make appears to do nothing.
    io.seed(builtDllPath(EXT, GUI_DLL), "built-gui");
    expect(resolveDll(context(), GUI_DLL)).toBe(builtDllPath(EXT, GUI_DLL));
    // The choice is per DLL, so a half-finished build cannot pair a new GUI
    // bridge with a stale mission one.
    expect(resolveDll(context(), MISSION_DLL)).toBe(shippedDllPath(EXT, MISSION_DLL));
  });
});

describe("inject", () => {
  it("copies both DLLs and the hook onto the layout DCS loads from", async () => {
    await inject(context(), WRITE_DIR);
    expect(io.read(dllInstallPath(WRITE_DIR, GUI_DLL))).toBe("shipped-gui");
    expect(io.read(dllInstallPath(WRITE_DIR, MISSION_DLL))).toBe("shipped-mission");
    expect(io.read(hookInstallPath(WRITE_DIR))).toBe("-- hook");
  });

  it("creates the bin and Hooks directories it copies into", async () => {
    // A DCS write dir that has never had a mod installed has neither directory,
    // and every copy would fail with ENOENT.
    expect(io.exists(path.join(WRITE_DIR, "Mods", "tech", "DcsStudio", "bin"))).toBe(false);
    await inject(context(), WRITE_DIR);
    expect(io.exists(path.join(WRITE_DIR, "Mods", "tech", "DcsStudio", "bin"))).toBe(true);
    expect(io.exists(path.join(WRITE_DIR, "Scripts", "Hooks"))).toBe(true);
  });

  it("overwrites an older install rather than leaving it in place", async () => {
    await inject(context(), WRITE_DIR);
    io.seed(shippedDllPath(EXT, GUI_DLL), "shipped-gui-v2");
    await inject(context(), WRITE_DIR);
    // A stale DLL beside a fresh hook script speaks a different protocol.
    expect(io.read(dllInstallPath(WRITE_DIR, GUI_DLL))).toBe("shipped-gui-v2");
  });

  it("clears stale single-DLL-era artifacts", async () => {
    // The old dcs_studio.dll binds port 25569 too: left behind, it answers
    // instead of the new GUI bridge and nothing the extension does lands.
    for (const stale of legacyInstallPaths(WRITE_DIR)) io.seed(stale, "old");
    await inject(context(), WRITE_DIR);
    for (const stale of legacyInstallPaths(WRITE_DIR)) expect(io.exists(stale)).toBe(false);
  });

  it("propagates a locked DLL so the caller can explain it", async () => {
    failWith({ copyFile: () => Promise.reject(lockedError()) });
    await expect(inject(context(), WRITE_DIR)).rejects.toMatchObject({ code: "EBUSY" });
  });

  it("still succeeds when a legacy artifact cannot be deleted", async () => {
    // Clearing yesterday's DLL is a courtesy; failing it must not report a
    // broken install when today's DLLs copied fine.
    const rm = io.rm;
    failWith({
      rm: (p, opts) => (p.endsWith("dcs_studio.dll") ? Promise.reject(lockedError()) : rm(p, opts)),
    });
    await expect(inject(context(), WRITE_DIR)).resolves.toBeUndefined();
    expect(io.read(dllInstallPath(WRITE_DIR, GUI_DLL))).toBe("shipped-gui");
  });
});

describe("eject", () => {
  it("removes both DLLs, the hook and the legacy artifacts", async () => {
    await inject(context(), WRITE_DIR);
    for (const stale of legacyInstallPaths(WRITE_DIR)) io.seed(stale, "old");

    await eject(WRITE_DIR);

    expect(io.exists(dllInstallPath(WRITE_DIR, GUI_DLL))).toBe(false);
    expect(io.exists(dllInstallPath(WRITE_DIR, MISSION_DLL))).toBe(false);
    expect(io.exists(hookInstallPath(WRITE_DIR))).toBe(false);
    for (const stale of legacyInstallPaths(WRITE_DIR)) expect(io.exists(stale)).toBe(false);
  });

  it("is safe to run when nothing was ever injected", async () => {
    // Extension shutdown ejects unconditionally; a user who never injected must
    // not see that fail — and nothing was left behind to report.
    await expect(eject(WRITE_DIR)).resolves.toEqual([]);
  });

  it("keeps removing the rest when one file is locked", async () => {
    // DCS holding the GUI DLL must not strand the hook script — the hook is
    // what makes DCS load the DLL again on the next run.
    await inject(context(), WRITE_DIR);
    const rm = io.rm;
    failWith({
      rm: (p, opts) => (p.endsWith(GUI_DLL) ? Promise.reject(lockedError()) : rm(p, opts)),
    });

    // The survivor is reported rather than swallowed: the caller has to be able
    // to tell the user the bridge is still installed.
    await expect(eject(WRITE_DIR)).resolves.toEqual([dllInstallPath(WRITE_DIR, GUI_DLL)]);

    expect(io.exists(dllInstallPath(WRITE_DIR, GUI_DLL))).toBe(true);
    expect(io.exists(hookInstallPath(WRITE_DIR))).toBe(false);
    expect(io.exists(dllInstallPath(WRITE_DIR, MISSION_DLL))).toBe(false);
  });

  it("still removes the DLLs when the hook script cannot be deleted", async () => {
    // Every file in the rollback is attempted independently, so one that will
    // not go does not strand the others.
    await inject(context(), WRITE_DIR);
    const hook = hookInstallPath(WRITE_DIR);
    const rm = io.rm;
    failWith({ rm: (p, opts) => (p === hook ? Promise.reject(lockedError()) : rm(p, opts)) });

    await expect(eject(WRITE_DIR)).resolves.toEqual([hookInstallPath(WRITE_DIR)]);

    expect(io.exists(dllInstallPath(WRITE_DIR, GUI_DLL))).toBe(false);
    expect(io.exists(dllInstallPath(WRITE_DIR, MISSION_DLL))).toBe(false);
  });
});

describe("injectCommand", () => {
  it("injects into the configured write dir and says where it landed", async () => {
    await injectCommand(context());
    expect(io.exists(dllInstallPath(WRITE_DIR, GUI_DLL))).toBe(true);
    expect(state.info).toEqual([expect.stringContaining(WRITE_DIR)]);
    expect(state.errors).toEqual([]);
  });

  it("tells the user to close DCS when a DLL is locked", async () => {
    failWith({ copyFile: () => Promise.reject(lockedError()) });
    await injectCommand(context());
    // A generic IO message would send them hunting a disk problem instead.
    expect(state.errors).toEqual([expect.stringContaining("DCS appears to be running")]);
    // No success toast — nothing was installed.
    expect(state.info).toEqual([]);
  });

  it("says which files were replaced when the inject fails part-way", async () => {
    // The scenario the layout makes possible: DCS holds the mission DLL, so the
    // GUI DLL is replaced and the hook never is. Reporting only "close DCS"
    // leaves the user with a mixed install they were never told about.
    const copyFile = io.copyFile;
    failWith({
      copyFile: (src, dest) =>
        dest.endsWith(MISSION_DLL) ? Promise.reject(lockedError()) : copyFile(src, dest),
    });

    await injectCommand(context());

    expect(state.errors).toEqual([
      "Could not overwrite the bridge DLLs — DCS appears to be running. Close DCS and inject again. The install is now mixed: dcs_studio_gui.dll was replaced and the rest were not — inject again once the problem is fixed, because DCS loads them as a set.",
    ]);
    // Nothing is rolled back: the DLL that will not copy is the one DCS is
    // running, and deleting the other would fail for the same reason while
    // destroying a working install.
    expect(io.read(dllInstallPath(WRITE_DIR, GUI_DLL))).toBe("shipped-gui");
    expect(io.exists(hookInstallPath(WRITE_DIR))).toBe(false);
    expect(state.info).toEqual([]);
  });

  it("names the DLLs it took from the workspace build", async () => {
    // The choice is made on existence alone, so a stale bridge\\target\\release
    // outranks a newer shipped DLL until someone deletes it — a failed cargo
    // build otherwise keeps deploying yesterday's binary in silence.
    io.seed(builtDllPath(EXT, GUI_DLL), "built-gui");

    await injectCommand(context());

    expect(state.info).toEqual([
      expect.stringContaining(
        "Deploying the locally built dcs_studio_gui.dll from bridge\\target\\release",
      ),
    ]);
  });

  it("reports any other IO failure with the underlying reason", async () => {
    failWith({ mkdir: () => Promise.reject(new Error("ENOSPC: no space left on device")) });
    await injectCommand(context());
    expect(state.errors).toEqual(["Inject failed: ENOSPC: no space left on device"]);
    expect(state.info).toEqual([]);
  });

  it("reports a non-Error rejection rather than swallowing it", async () => {
    failWith({ copyFile: () => Promise.reject("access denied") });
    await injectCommand(context());
    expect(state.errors).toEqual(["Inject failed: access denied"]);
  });
});

describe("ejectCommand", () => {
  it("ejects from the configured write dir and confirms it", async () => {
    await inject(context(), WRITE_DIR);
    await ejectCommand();
    expect(io.exists(dllInstallPath(WRITE_DIR, GUI_DLL))).toBe(false);
    expect(state.info).toEqual([`Bridge ejected from ${WRITE_DIR}.`]);
  });

  it("reports the files a running DCS would not let go of", async () => {
    // "Bridge ejected" while the GUI DLL is still there sends the user away
    // believing the extension's code is out of their DCS, and the next start
    // loads it again.
    await inject(context(), WRITE_DIR);
    const rm = io.rm;
    failWith({
      rm: (p, opts) => (p.endsWith(GUI_DLL) ? Promise.reject(lockedError()) : rm(p, opts)),
    });

    await ejectCommand();

    expect(state.warnings).toEqual([
      `Bridge only partly ejected from ${WRITE_DIR} — dcs_studio_gui.dll could not be removed. Close DCS and eject again.`,
    ]);
    expect(state.info).toEqual([]);
  });
});
