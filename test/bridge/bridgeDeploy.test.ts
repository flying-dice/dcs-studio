import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  DCS_LAUNCH_ARGS,
  DLL_RELATIVE_PATH,
  HOOK_RELATIVE_PATH,
  INJECT_LOCKED_MESSAGE,
  LAUNCH_LOCKED_MESSAGE,
  builtDllPath,
  dcsBinDir,
  dcsExePath,
  dllInstallPath,
  ejectedMessage,
  hookInstallPath,
  hookSourcePath,
  injectedMessage,
  isDllLockedError,
  selectDll,
  shippedDllPath,
  shouldEjectOnShutdown,
} from "../../src/core/domain/bridgeDeploy";

const ROOT = path.join("C:", "ext");
const WRITE = path.join("C:", "Users", "me", "Saved Games", "DCS");

describe("install layout", () => {
  it("uses the dcs-studio layout inside the write dir", () => {
    expect(DLL_RELATIVE_PATH).toBe(path.join("Mods", "tech", "DcsStudio", "bin", "dcs_studio.dll"));
    expect(HOOK_RELATIVE_PATH).toBe(path.join("Scripts", "Hooks", "DcsStudio.lua"));
    expect(dllInstallPath(WRITE)).toBe(path.join(WRITE, DLL_RELATIVE_PATH));
    expect(hookInstallPath(WRITE)).toBe(path.join(WRITE, HOOK_RELATIVE_PATH));
  });
});

describe("DLL selection (built vs shipped)", () => {
  it("computes both candidate paths from the extension root", () => {
    expect(builtDllPath(ROOT)).toBe(path.join(ROOT, "native", "target", "release", "dcs_studio.dll"));
    expect(shippedDllPath(ROOT)).toBe(path.join(ROOT, "bridge", "dcs_studio.dll"));
    expect(hookSourcePath(ROOT)).toBe(path.join(ROOT, "bridge", "Scripts", "Hooks", "DcsStudio.lua"));
  });

  it("prefers the freshly built crate when it exists", () => {
    expect(selectDll(ROOT, true)).toBe(builtDllPath(ROOT));
  });

  it("falls back to the shipped DLL when there is no build", () => {
    expect(selectDll(ROOT, false)).toBe(shippedDllPath(ROOT));
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
      "Could not overwrite dcs_studio.dll — DCS appears to be running. Close DCS and inject again.",
    );
    expect(LAUNCH_LOCKED_MESSAGE).toBe("Bridge DLL is locked — is DCS already running?");
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
