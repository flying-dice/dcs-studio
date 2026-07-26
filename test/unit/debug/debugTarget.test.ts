import { describe, expect, it } from "vitest";
import {
  isMissionScriptingFile,
  MISSION_SCRIPT_REFUSAL,
} from "../../../src/core/domain/debugTarget";

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
