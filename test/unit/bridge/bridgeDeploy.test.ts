import { win32 as path } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BIN_RELATIVE_DIR,
  BRIDGE_DLLS,
  builtDllNote,
  builtDllPath,
  DCS_LAUNCH_ARGS,
  dcsBinDir,
  dcsExePath,
  dcsExitNote,
  dllInstallPath,
  ejectedMessage,
  ejectIncompleteMessage,
  HOOK_RELATIVE_PATH,
  hookInstallPath,
  hookSourcePath,
  INJECT_LOCKED_MESSAGE,
  injectedMessage,
  isDllLockedError,
  LAUNCH_LOCKED_MESSAGE,
  LEGACY_RELATIVE_PATHS,
  legacyInstallPaths,
  partialInstallMessage,
  selectDll,
  shippedDllPath,
  shouldEjectOnShutdown,
} from "../../../src/core/domain/bridgeDeploy";

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
    expect(selectDll(ROOT, "dcs_studio_gui.dll", true)).toBe(
      builtDllPath(ROOT, "dcs_studio_gui.dll"),
    );
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

  it("names the locally built DLLs a deploy is about to use", () => {
    // Selection is on existence alone, so a stale bridge\\target\\release keeps
    // winning over a newer shipped DLL: saying which binary is going in is what
    // lets a user notice their cargo build failed hours ago.
    expect(builtDllNote([])).toBe("");
    expect(injectedMessage(WRITE, [...BRIDGE_DLLS])).toBe(
      `Bridge injected into ${WRITE}. Restart DCS (or run DCS Studio: Launch DCS) to load it.` +
        " Deploying the locally built dcs_studio_gui.dll and dcs_studio_mission.dll from" +
        " bridge\\target\\release — delete that folder to go back to the DLLs shipped with the" +
        " extension.",
    );
  });

  it("says what an eject left behind rather than claiming a clean one", () => {
    // "Bridge ejected" while a locked DLL is still there sends the user away
    // believing the extension's code is out of their DCS.
    expect(ejectIncompleteMessage(WRITE, [dllInstallPath(WRITE, BRIDGE_DLLS[0])])).toBe(
      `Bridge only partly ejected from ${WRITE} — dcs_studio_gui.dll could not be removed.` +
        " Close DCS and eject again.",
    );
  });
});

describe("a part-finished inject", () => {
  it("says nothing when the failure came before anything was replaced", () => {
    expect(partialInstallMessage([])).toBeUndefined();
  });

  it("names what was replaced when the failure came half way", () => {
    // DCS loads the two DLLs and the hook as a set: a new GUI bridge beside
    // yesterday's mission bridge is a version mismatch nobody was told about.
    expect(partialInstallMessage([dllInstallPath(WRITE, BRIDGE_DLLS[0])])).toBe(
      " The install is now mixed: dcs_studio_gui.dll was replaced and the rest were not —" +
        " inject again once the problem is fixed, because DCS loads them as a set.",
    );
    expect(partialInstallMessage(BRIDGE_DLLS.map((n) => dllInstallPath(WRITE, n)))).toBe(
      " The install is now mixed: dcs_studio_gui.dll and dcs_studio_mission.dll were replaced" +
        " and the rest were not — inject again once the problem is fixed, because DCS loads" +
        " them as a set.",
    );
  });
});

describe("how DCS ended", () => {
  it("says nothing about a clean quit", () => {
    expect(dcsExitNote(0, null)).toBe("");
  });

  it("reports a non-zero exit, because a sim that dies on startup looks like a quit", () => {
    expect(dcsExitNote(1, null)).toBe(
      "DCS exited with code 1 — it may have failed on startup. Check dcs.log (command:" +
        " “DCS Studio: Open DCS Log Viewer”). The bridge has been ejected.",
    );
  });

  it("names the signal when there was no exit code at all", () => {
    expect(dcsExitNote(null, "SIGKILL")).toBe(
      "DCS was terminated by SIGKILL before it exited on its own. The bridge has been ejected.",
    );
    // node reports no signal for a child it never managed to track.
    expect(dcsExitNote(null, undefined)).toBe(
      "DCS was terminated by a signal before it exited on its own. The bridge has been ejected.",
    );
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
    // The argument is "is DCS still running", present tense — a reading of it
    // as "did we launch DCS" inverts the policy and rips the DLL out from
    // under a live sim.
    expect(shouldEjectOnShutdown(false)).toBe(true);
    expect(shouldEjectOnShutdown(true)).toBe(false);
  });
});
