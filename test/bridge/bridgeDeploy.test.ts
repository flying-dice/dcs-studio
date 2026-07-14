import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  BIN_RELATIVE_DIR,
  BRIDGE_DLLS,
  DCS_LAUNCH_ARGS,
  HOOK_RELATIVE_PATH,
  INJECT_LOCKED_MESSAGE,
  LAUNCH_LOCKED_MESSAGE,
  LEGACY_RELATIVE_PATHS,
  builtDllPath,
  dcsBinDir,
  dcsExePath,
  dllInstallPath,
  ejectedMessage,
  hookInstallPath,
  hookSourcePath,
  injectedMessage,
  isDllLockedError,
  legacyInstallPaths,
  selectDll,
  shippedDllPath,
  shouldEjectOnShutdown,
} from "../../src/core/domain/bridgeDeploy";

const ROOT = path.join("C:", "ext");
const WRITE = path.join("C:", "Users", "me", "Saved Games", "DCS");

describe("install layout", () => {
  it("installs both bridge DLLs into the dcs-studio bin dir", () => {
    expect([...BRIDGE_DLLS]).toEqual(["dcs_studio_gui.dll", "dcs_studio_mission.dll"]);
    expect(BIN_RELATIVE_DIR).toBe(path.join("Mods", "tech", "DcsStudio", "bin"));
    expect(HOOK_RELATIVE_PATH).toBe(path.join("Scripts", "Hooks", "DcsStudio.lua"));
    for (const name of BRIDGE_DLLS) {
      expect(dllInstallPath(WRITE, name)).toBe(path.join(WRITE, BIN_RELATIVE_DIR, name));
    }
    expect(hookInstallPath(WRITE)).toBe(path.join(WRITE, HOOK_RELATIVE_PATH));
  });

  it("targets the single-DLL-era artifacts for cleanup", () => {
    expect(LEGACY_RELATIVE_PATHS).toEqual([
      path.join(BIN_RELATIVE_DIR, "dcs_studio.dll"),
      path.join(BIN_RELATIVE_DIR, "dcs_bridge.dll"),
      path.join("Scripts", "DcsStudioMission.lua"),
    ]);
    expect(legacyInstallPaths(WRITE)).toEqual(
      LEGACY_RELATIVE_PATHS.map((p) => path.join(WRITE, p)),
    );
  });
});

describe("DLL selection (built vs shipped)", () => {
  it("computes both candidate paths from the extension root, per DLL", () => {
    for (const name of BRIDGE_DLLS) {
      expect(builtDllPath(ROOT, name)).toBe(path.join(ROOT, "bridge", "target", "release", name));
      expect(shippedDllPath(ROOT, name)).toBe(path.join(ROOT, "bridge", "prebuilt", name));
    }
    expect(hookSourcePath(ROOT)).toBe(path.join(ROOT, "bridge", "hook", "DcsStudio.lua"));
  });

  it("prefers the freshly built workspace artifact when it exists", () => {
    expect(selectDll(ROOT, "dcs_studio_gui.dll", true)).toBe(builtDllPath(ROOT, "dcs_studio_gui.dll"));
  });

  it("falls back to the shipped DLL when there is no build", () => {
    expect(selectDll(ROOT, "dcs_studio_mission.dll", false)).toBe(
      shippedDllPath(ROOT, "dcs_studio_mission.dll"),
    );
  });
});

describe("locked-DLL classification", () => {
  it("EBUSY and EPERM mean DCS holds the DLL", () => {
    expect(isDllLockedError({ code: "EBUSY" })).toBe(true);
    expect(isDllLockedError({ code: "EPERM" })).toBe(true);
  });

  it("anything else is a plain IO error", () => {
    expect(isDllLockedError({ code: "ENOENT" })).toBe(false);
    expect(isDllLockedError(new Error("boom"))).toBe(false);
    expect(isDllLockedError(null)).toBe(false);
    expect(isDllLockedError(undefined)).toBe(false);
    expect(isDllLockedError("EBUSY")).toBe(false);
  });

  it("carries the exact user-facing messages", () => {
    expect(INJECT_LOCKED_MESSAGE).toBe(
      "Could not overwrite the bridge DLLs — DCS appears to be running. Close DCS and inject again.",
    );
    expect(LAUNCH_LOCKED_MESSAGE).toBe("A bridge DLL is locked — is DCS already running?");
  });
});

describe("toasts", () => {
  it("inject/eject messages embed the write dir", () => {
    expect(injectedMessage(WRITE)).toBe(
      `Bridge injected into ${WRITE}. Restart DCS (or run DCS Studio: Launch DCS) to load it.`,
    );
    expect(ejectedMessage(WRITE)).toBe(`Bridge ejected from ${WRITE}.`);
  });
});

describe("launch rules", () => {
  it("always passes --no-launcher and nothing else", () => {
    expect([...DCS_LAUNCH_ARGS]).toEqual(["--no-launcher"]);
  });

  it("locates DCS.exe under <install>/bin", () => {
    const install = path.join("D:", "DCS World");
    expect(dcsBinDir(install)).toBe(path.join(install, "bin"));
    expect(dcsExePath(install)).toBe(path.join(install, "bin", "DCS.exe"));
  });
});

describe("eject-on-shutdown policy", () => {
  it("ejects only when no managed DCS process is alive", () => {
    expect(shouldEjectOnShutdown(false)).toBe(true);
    expect(shouldEjectOnShutdown(true)).toBe(false);
  });
});
