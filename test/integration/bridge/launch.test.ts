import type { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpawnHarness, type SpawnHarness } from "../../support/fakeChildProcess";
import { resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

import * as vscode from "vscode";
import { useBridgeFs } from "../../../src/bridge/deploy";
import { launchCleanup, launchDcs } from "../../../src/bridge/launch";
import {
  dllInstallPath,
  hookInstallPath,
  hookSourcePath,
  shippedDllPath,
} from "../../../src/core/domain/bridgeDeploy";
import { lockedError, type MappedBridgeFs, mappedBridgeFs } from "./mappedBridgeFs";

// The managed launch owns a user's DCS install for the length of a session: it
// puts the bridge in before starting the sim and takes it out again when the sim
// exits. Both halves have to hold. Skipping the eject leaves the extension's
// DLLs loaded into every later DCS run, including runs the extension knows
// nothing about; spawning while a DLL is locked means DCS is already up, and
// starting a second copy is how people corrupt their config.

const GUI_DLL = "dcs_studio_gui.dll";
const MISSION_DLL = "dcs_studio_mission.dll";
const EXT = "C:\\ext";
const WRITE_DIR = "D:\\Saved Games\\DCS";
const GAME_INSTALL = "D:\\DCS World";
const EXE = "D:\\DCS World\\bin\\DCS.exe";

let root: string;
let io: MappedBridgeFs;
let restore: () => void;
let harness: SpawnHarness;

function context(): vscode.ExtensionContext {
  return { extensionUri: vscode.Uri.file(EXT) } as unknown as vscode.ExtensionContext;
}

/** The harness's spawn, in the shape launchDcs takes. */
function fakeSpawn(): typeof nodeSpawn {
  return harness.spawn as unknown as typeof nodeSpawn;
}

/** Launch with a process that stays alive until the test says otherwise. */
async function launchLive(): Promise<void> {
  harness.plan(() => undefined);
  await launchDcs(context(), fakeSpawn());
}

beforeEach(() => {
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "bridge-launch-"));
  io = mappedBridgeFs(root);
  restore = useBridgeFs(io);
  harness = createSpawnHarness();
  resetVscode({
    config: {
      "dcsStudio.savedGamesPath": WRITE_DIR,
      "dcsStudio.gameInstallPath": GAME_INSTALL,
    },
  });
  io.seed(shippedDllPath(EXT, GUI_DLL), "gui");
  io.seed(shippedDllPath(EXT, MISSION_DLL), "mission");
  io.seed(hookSourcePath(EXT), "-- hook");
  io.seed(EXE, "MZ");
});

afterEach(async () => {
  // A process still "running" holds the module's launched-DCS flag, which would
  // make the next test look like a double launch.
  for (const child of harness.children) child.emit("exit", 0);
  await new Promise((r) => setTimeout(r, 10));
  restore();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("preconditions", () => {
  it("asks for the install path when it has not been configured", async () => {
    state.config["dcsStudio.gameInstallPath"] = "";
    await launchDcs(context(), fakeSpawn());
    expect(state.errors).toEqual([expect.stringContaining("dcsStudio.gameInstallPath")]);
    expect(harness.calls).toEqual([]);
  });

  it("names the path it looked for when DCS.exe is not there", async () => {
    // Usually a path pointing at the Saved Games folder rather than the install
    // — quoting the path is what makes that obvious.
    state.config["dcsStudio.gameInstallPath"] = "D:\\Wrong";
    await launchDcs(context(), fakeSpawn());
    expect(state.errors).toEqual([`DCS.exe not found at D:\\Wrong\\bin\\DCS.exe.`]);
    expect(harness.calls).toEqual([]);
  });

  it("refuses to start a second DCS", async () => {
    await launchLive();
    await launchDcs(context(), fakeSpawn());
    // Two sims writing the same config and log files corrupts both.
    expect(harness.calls).toHaveLength(1);
    expect(state.info).toContain("DCS was already launched by DCS Studio.");
  });
});

describe("injecting before launch", () => {
  it("puts the bridge in place before starting the sim", async () => {
    await launchLive();
    // DCS reads Scripts\Hooks at startup; injecting after the spawn is a race
    // that silently produces a DCS with no bridge.
    expect(io.read(dllInstallPath(WRITE_DIR, GUI_DLL))).toBe("gui");
    expect(io.read(hookInstallPath(WRITE_DIR))).toBe("-- hook");
    expect(harness.calls).toHaveLength(1);
  });

  it("aborts when a DLL is locked, because DCS is already running", async () => {
    restore();
    io = mappedBridgeFs(root, { copyFile: () => Promise.reject(lockedError()) });
    restore = useBridgeFs(io);

    await launchDcs(context(), fakeSpawn());

    expect(state.errors).toEqual(["A bridge DLL is locked — is DCS already running?"]);
    // Fails closed: no second sim on top of the one already holding the DLL.
    expect(harness.calls).toEqual([]);
  });

  it("reports any other inject failure and does not launch", async () => {
    restore();
    io = mappedBridgeFs(root, { mkdir: () => Promise.reject(new Error("EACCES: denied")) });
    restore = useBridgeFs(io);

    await launchDcs(context(), fakeSpawn());

    expect(state.errors).toEqual(["Inject failed before launch: EACCES: denied"]);
    expect(harness.calls).toEqual([]);
  });

  it("reports a non-Error inject failure rather than launching regardless", async () => {
    restore();
    io = mappedBridgeFs(root, { copyFile: () => Promise.reject("weird") });
    restore = useBridgeFs(io);

    await launchDcs(context(), fakeSpawn());

    expect(state.errors).toEqual(["Inject failed before launch: weird"]);
    expect(harness.calls).toEqual([]);
  });
});

describe("the spawn", () => {
  it("runs DCS.exe with --no-launcher, detached from the extension host", async () => {
    await launchLive();
    // Without --no-launcher DCS opens the ED launcher instead of the sim; a
    // non-detached child would be killed with VS Code, taking DCS down with it.
    expect(harness.calls[0]).toEqual({
      cmd: EXE,
      args: ["--no-launcher"],
      opts: { cwd: "D:\\DCS World\\bin", detached: true, stdio: "ignore" },
    });
    expect(harness.children[0].unrefCount).toBe(1);
    expect(state.info).toContain("Launching DCS with the DCS Studio bridge…");
  });

  it("ejects the bridge once DCS exits", async () => {
    await launchLive();
    harness.children[0].emit("exit", 0);
    // Leaving the DLLs behind means every later DCS run — started from the
    // desktop, with VS Code closed — still loads the extension's code.
    await vi.waitFor(() => {
      expect(io.exists(dllInstallPath(WRITE_DIR, GUI_DLL))).toBe(false);
      expect(io.exists(hookInstallPath(WRITE_DIR))).toBe(false);
    });
  });

  it("allows a relaunch after DCS has exited", async () => {
    await launchLive();
    harness.children[0].emit("exit", 0);
    await launchLive();
    expect(harness.calls).toHaveLength(2);
  });

  it("reports a spawn that never started and forgets the process", async () => {
    await launchLive();
    harness.children[0].emit("error", new Error("spawn EACCES"));
    expect(state.errors).toEqual(["Failed to start DCS: spawn EACCES"]);
    // The failed launch must not block the next attempt.
    await launchLive();
    expect(harness.calls).toHaveLength(2);
  });

  it("uses the real child_process by default", async () => {
    // The seam is for these specs only; the shipped command has to reach the
    // OS. Here that means a genuine ENOENT for a Windows path on this host.
    await launchDcs(context());
    await vi.waitFor(() =>
      expect(state.errors).toEqual([expect.stringContaining("Failed to start DCS")]),
    );
  });
});

describe("launchCleanup", () => {
  it("ejects the bridge when the extension shuts down with no DCS running", async () => {
    await launchLive();
    harness.children[0].emit("exit", 0);
    await vi.waitFor(() => expect(io.exists(hookInstallPath(WRITE_DIR))).toBe(false));
    io.seed(hookInstallPath(WRITE_DIR), "-- hook");

    launchCleanup();

    await vi.waitFor(() => expect(io.exists(hookInstallPath(WRITE_DIR))).toBe(false));
  });

  it("leaves the bridge alone while DCS is still running", async () => {
    await launchLive();
    launchCleanup();
    // The DLL is locked anyway, and deleting the hook mid-session breaks the
    // mission bridge's boot dispatch for the rest of the run.
    await new Promise((r) => setTimeout(r, 10));
    expect(io.exists(hookInstallPath(WRITE_DIR))).toBe(true);
  });
});
