import { describe, expect, it } from "vitest";
import {
  isMissionScriptingFile,
  MISSION_FILE,
  MISSION_SCRIPT_REFUSAL,
  missionScriptPath,
} from "../../../src/core/domain/debugTarget";
import type { InstallRootsPort } from "../../../src/core/ports/installRoots";

const roots = (gameInstall: string): InstallRootsPort =>
  ({ gameInstall: () => gameInstall }) as unknown as InstallRootsPort;

// The predicate behind the refusal, which now has to hold at four front doors:
// the menu `when` clauses, the command handler (palette, keybinding,
// executeCommand), the F5-with-no-launch.json path, and a hand-written
// launch.json once `${file}` has resolved (issue #30).

describe("isMissionScriptingFile", () => {
  it("matches the file whatever separator the path is spelled with", () => {
    // An fsPath carries Windows backslashes whatever the host's separator is,
    // and a launch.json may spell either.
    expect(isMissionScriptingFile("C:\\SG\\DCS\\Scripts\\MissionScripting.lua")).toBe(true);
    expect(isMissionScriptingFile("C:/SG/DCS/Scripts/MissionScripting.lua")).toBe(true);
    expect(isMissionScriptingFile("MissionScripting.lua")).toBe(true);
  });

  it("matches regardless of case, because Windows filenames are case-insensitive", () => {
    expect(isMissionScriptingFile("scripts/missionscripting.lua")).toBe(true);
    expect(isMissionScriptingFile("Scripts/MISSIONSCRIPTING.LUA")).toBe(true);
  });

  it("leaves a file that merely ends with the name alone", () => {
    // Somebody's own my-MissionScripting.lua is an ordinary script and runs.
    expect(isMissionScriptingFile("C:\\mod\\my-MissionScripting.lua")).toBe(false);
    expect(isMissionScriptingFile("MissionScripting.lua.bak")).toBe(false);
    expect(isMissionScriptingFile("MissionScripting/init.lua")).toBe(false);
  });

  it("says no for an empty path rather than throwing", () => {
    expect(isMissionScriptingFile("")).toBe(false);
  });
});

describe("MISSION_SCRIPT_REFUSAL", () => {
  it("says why, and names the command that does what the user wanted", () => {
    // A refusal with no way forward sends the user looking for a workaround —
    // and the workaround here is editing the sandbox by hand.
    expect(MISSION_SCRIPT_REFUSAL).toContain("defines the mission sandbox");
    expect(MISSION_SCRIPT_REFUSAL).toContain("Desanitize MissionScripting.lua");
  });
});

describe("missionScriptPath", () => {
  // Moved here from beside the panel that manages the file: the debug adapter
  // needs it too, and a feature borrowing a pure rule from another feature is
  // the boundary violation #61 tracks.

  it("names the file under the configured install's Scripts folder", () => {
    expect(missionScriptPath(roots("D:\\DCS World"))).toBe(
      "D:\\DCS World\\Scripts\\MissionScripting.lua",
    );
  });

  it("joins with Windows separators whatever the host and the input are", () => {
    // DCS is Windows-only. A posix join would hand the caller a path with
    // forward slashes that no DCS install has, and it would report the sandbox
    // un-sanitized because it could not find the file. win32.join also
    // normalises a forward-slashed root, so a setting pasted from a URL or
    // typed by a developer on a Mac still lands on the real path.
    expect(missionScriptPath(roots("C:/DCS"))).toBe("C:\\DCS\\Scripts\\MissionScripting.lua");
  });

  it("is undefined when no install path is configured", () => {
    // The caller's cue to ask the user to set one, rather than to join onto an
    // empty string and probe the filesystem root.
    expect(missionScriptPath(roots(""))).toBeUndefined();
  });

  it("names the file DCS actually reads", () => {
    expect(MISSION_FILE).toBe("MissionScripting.lua");
  });
});
