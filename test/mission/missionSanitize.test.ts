import { describe, it, expect } from "vitest";
import {
  ITEMS,
  stripQuoted,
  codeMatches,
  lineState,
  toggledLine,
  backupPath,
  scanItems,
  applyDesired,
  allItems,
} from "../../src/core/domain/missionSanitize";

// A realistic MissionScripting.lua body (the DCS-shipped shape).
const PRISTINE_LF = [
  "--Initialization script for the Mission lua Environment (SSE)",
  "",
  "dofile('Scripts/ScriptingSystem.lua')",
  "",
  "--Sanitize Mission Scripting environment",
  "--This makes unavailable some unsecure functions.",
  "--Mission downloaded from server to client may contain potentialy harmful lua code that may use these functions.",
  "--You can remove the code below and make availble these functions at your own risk.",
  "local function sanitizeModule(name)",
  "\t_G[name] = nil",
  "\tpackage.loaded[name] = nil",
  "end",
  "",
  "do",
  "\tsanitizeModule('os')",
  "\tsanitizeModule('io')",
  "\tsanitizeModule('lfs')",
  "\t_G['require'] = nil",
  "\t_G['loadlib'] = nil",
  "\t_G['package'] = nil",
  "end",
].join("\n");

const PRISTINE_CRLF = PRISTINE_LF.replace(/\n/g, "\r\n");

describe("ITEMS", () => {
  it("lists the six lockdown items in DCS order", () => {
    expect([...ITEMS]).toEqual(["os", "io", "lfs", "require", "loadlib", "package"]);
  });
});

describe("stripQuoted", () => {
  it("strips a single-quoted name", () => {
    expect(stripQuoted("'os')", "os")).toBe(")");
  });
  it("strips a double-quoted name", () => {
    expect(stripQuoted('"io") rest', "io")).toBe(") rest");
  });
  it("rejects a mismatched name inside quotes", () => {
    expect(stripQuoted("'osx')", "os")).toBeNull();
  });
  it("rejects a name whose closing quote is missing or mismatched", () => {
    expect(stripQuoted("'os\")", "os")).toBeNull();
    expect(stripQuoted("'os", "os")).toBeNull();
  });
  it("rejects input that does not start with a quote", () => {
    expect(stripQuoted("os')", "os")).toBeNull();
  });
  it("rejects a shorter string than the name", () => {
    expect(stripQuoted("'o", "os")).toBeNull();
  });
});

describe("codeMatches — sanitizeModule items", () => {
  it("matches the canonical form", () => {
    expect(codeMatches("sanitizeModule('os')", "os")).toBe(true);
    expect(codeMatches("sanitizeModule('io')", "io")).toBe(true);
    expect(codeMatches("sanitizeModule('lfs')", "lfs")).toBe(true);
  });
  it("tolerates surrounding and internal whitespace", () => {
    expect(codeMatches("  sanitizeModule ( 'os' )  ", "os")).toBe(true);
  });
  it("tolerates double quotes", () => {
    expect(codeMatches('sanitizeModule("os")', "os")).toBe(true);
  });
  it("rejects a different module name", () => {
    expect(codeMatches("sanitizeModule('io')", "os")).toBe(false);
  });
  it("rejects a missing sanitizeModule prefix", () => {
    expect(codeMatches("cleanModule('os')", "os")).toBe(false);
  });
  it("rejects a missing open paren", () => {
    expect(codeMatches("sanitizeModule 'os')", "os")).toBe(false);
  });
  it("rejects an unquoted argument", () => {
    expect(codeMatches("sanitizeModule(os)", "os")).toBe(false);
  });
  it("rejects a missing close paren", () => {
    expect(codeMatches("sanitizeModule('os'", "os")).toBe(false);
  });
});

describe("codeMatches — _G items", () => {
  it("matches the canonical form", () => {
    expect(codeMatches("_G['require'] = nil", "require")).toBe(true);
    expect(codeMatches("_G['loadlib'] = nil", "loadlib")).toBe(true);
    expect(codeMatches("_G['package'] = nil", "package")).toBe(true);
  });
  it("tolerates whitespace and double quotes", () => {
    expect(codeMatches('_G [ "require" ] =  nil', "require")).toBe(true);
  });
  it("rejects a missing _G prefix", () => {
    expect(codeMatches("G['require'] = nil", "require")).toBe(false);
  });
  it("rejects a missing open bracket", () => {
    expect(codeMatches("_G'require'] = nil", "require")).toBe(false);
  });
  it("rejects an unquoted key", () => {
    expect(codeMatches("_G[require] = nil", "require")).toBe(false);
  });
  it("rejects a missing close bracket", () => {
    expect(codeMatches("_G['require' = nil", "require")).toBe(false);
  });
  it("rejects a missing equals", () => {
    expect(codeMatches("_G['require'] nil", "require")).toBe(false);
  });
  it("rejects a non-nil assignment", () => {
    expect(codeMatches("_G['require'] = require", "require")).toBe(false);
  });
});

describe("lineState", () => {
  it("reports an active (sanitized) line", () => {
    expect(lineState("\tsanitizeModule('os')", "os")).toBe(true);
    expect(lineState("    _G['require'] = nil", "require")).toBe(true);
  });
  it("reports a commented line with '-- ' spacing", () => {
    expect(lineState("\t-- sanitizeModule('os')", "os")).toBe(false);
  });
  it("reports a commented line without a space after --", () => {
    expect(lineState("\t--sanitizeModule('os')", "os")).toBe(false);
  });
  it("returns null for a commented non-matching line", () => {
    expect(lineState("--Sanitize Mission Scripting environment", "os")).toBeNull();
  });
  it("returns null for an uncommented non-matching line", () => {
    expect(lineState("dofile('Scripts/ScriptingSystem.lua')", "os")).toBeNull();
  });
  it("does not confuse items across lines", () => {
    expect(lineState("\tsanitizeModule('io')", "os")).toBeNull();
    expect(lineState("\t_G['package'] = nil", "require")).toBeNull();
  });
});

describe("toggledLine", () => {
  it("comments an active line, preserving tab indentation", () => {
    expect(toggledLine("\tsanitizeModule('os')", { os: false })).toBe("\t-- sanitizeModule('os')");
  });
  it("comments an active line, preserving space indentation", () => {
    expect(toggledLine("    _G['require'] = nil", { require: false })).toBe(
      "    -- _G['require'] = nil",
    );
  });
  it("uncomments a '-- ' line, preserving indentation", () => {
    expect(toggledLine("\t-- sanitizeModule('os')", { os: true })).toBe("\tsanitizeModule('os')");
  });
  it("uncomments a '--' line without trailing space", () => {
    expect(toggledLine("\t--sanitizeModule('os')", { os: true })).toBe("\tsanitizeModule('os')");
  });
  it("returns null when the line is already in the desired state", () => {
    expect(toggledLine("\tsanitizeModule('os')", { os: true })).toBeNull();
    expect(toggledLine("\t-- sanitizeModule('os')", { os: false })).toBeNull();
  });
  it("returns null when no requested item matches", () => {
    expect(toggledLine("\tsanitizeModule('os')", { io: false })).toBeNull();
    expect(toggledLine("dofile('x.lua')", allItems(false))).toBeNull();
  });
  it("finds the matching item beyond the first desired key", () => {
    expect(toggledLine("\tsanitizeModule('io')", { os: false, io: false })).toBe(
      "\t-- sanitizeModule('io')",
    );
  });
});

describe("backupPath", () => {
  it("appends .dcsstudio.bak", () => {
    expect(backupPath("C:\\DCS\\Scripts\\MissionScripting.lua")).toBe(
      "C:\\DCS\\Scripts\\MissionScripting.lua.dcsstudio.bak",
    );
  });
});

describe("scanItems", () => {
  it("reports every item present and sanitized in the pristine file", () => {
    for (const item of scanItems(PRISTINE_LF)) {
      expect(item).toEqual({ name: item.name, present: true, sanitized: true });
    }
  });
  it("reports commented items as present but not sanitized", () => {
    const desanitized = applyDesired(PRISTINE_LF, allItems(false)).content;
    for (const item of scanItems(desanitized)) {
      expect(item).toEqual({ name: item.name, present: true, sanitized: false });
    }
  });
  it("reports missing items as absent", () => {
    const items = scanItems("print('hello')\n");
    expect(items).toHaveLength(ITEMS.length);
    for (const item of items) {
      expect(item.present).toBe(false);
      expect(item.sanitized).toBe(false);
    }
  });
  it("handles CRLF content (trailing \\r does not break matching)", () => {
    // scanItems splits on \n only; active lines still match because codeMatches trims.
    const items = scanItems(PRISTINE_CRLF);
    for (const item of items) expect(item.present).toBe(true);
  });
});

describe("applyDesired", () => {
  it("desanitizes every lockdown line, preserving LF and indentation", () => {
    const { content, changed } = applyDesired(PRISTINE_LF, allItems(false));
    expect(changed).toBe(true);
    expect(content).not.toContain("\r\n");
    expect(content).toContain("\t-- sanitizeModule('os')");
    expect(content).toContain("\t-- sanitizeModule('io')");
    expect(content).toContain("\t-- sanitizeModule('lfs')");
    expect(content).toContain("\t-- _G['require'] = nil");
    expect(content).toContain("\t-- _G['loadlib'] = nil");
    expect(content).toContain("\t-- _G['package'] = nil");
    // Untouched lines survive verbatim.
    expect(content).toContain("dofile('Scripts/ScriptingSystem.lua')");
    expect(content).toContain("local function sanitizeModule(name)");
  });

  it("preserves CRLF line endings", () => {
    const { content, changed } = applyDesired(PRISTINE_CRLF, allItems(false));
    expect(changed).toBe(true);
    expect(content.split("\r\n").length).toBe(PRISTINE_CRLF.split("\r\n").length);
    expect(content).not.toMatch(/[^\r]\n/);
    expect(content).toContain("\t-- sanitizeModule('os')\r\n");
  });

  it("round-trips: desanitize then re-sanitize restores the original", () => {
    for (const original of [PRISTINE_LF, PRISTINE_CRLF]) {
      const desanitized = applyDesired(original, allItems(false)).content;
      const restored = applyDesired(desanitized, allItems(true));
      expect(restored.changed).toBe(true);
      expect(restored.content).toBe(original);
    }
  });

  it("reports changed=false and leaves content intact when already in the desired state", () => {
    const { content, changed } = applyDesired(PRISTINE_LF, allItems(true));
    expect(changed).toBe(false);
    expect(content).toBe(PRISTINE_LF);
  });

  it("toggles only the requested items", () => {
    const { content } = applyDesired(PRISTINE_LF, { os: false });
    expect(content).toContain("\t-- sanitizeModule('os')");
    expect(content).toContain("\tsanitizeModule('io')");
    expect(content).toContain("\t_G['require'] = nil");
  });

  it("does not touch the sanitizeModule definition or comment banner", () => {
    const { content } = applyDesired(PRISTINE_LF, allItems(false));
    expect(content).toContain("local function sanitizeModule(name)");
    expect(content).toContain("--Sanitize Mission Scripting environment");
    // The helper body's `_G[name] = nil` is unquoted, so it must not be toggled.
    expect(content).toContain("\t_G[name] = nil");
  });
});

describe("allItems", () => {
  it("maps every item to the given state", () => {
    expect(allItems(true)).toEqual({
      os: true,
      io: true,
      lfs: true,
      require: true,
      loadlib: true,
      package: true,
    });
    expect(Object.values(allItems(false))).toEqual([false, false, false, false, false, false]);
  });
});
