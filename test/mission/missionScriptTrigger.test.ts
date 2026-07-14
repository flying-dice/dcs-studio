import { describe, expect, it } from "vitest";
import {
  AFTER_SANITIZE_FILE,
  AFTER_TRIGGER,
  BEFORE_SANITIZE_FILE,
  BEFORE_TRIGGER,
  installTriggers,
  isAfterTrigger,
  isBeforeTrigger,
  removeTriggers,
  triggerStatus,
} from "../../src/core/domain/missionScriptTrigger";

// The DCS-shipped MissionScripting.lua shape (matches missionSanitize's fixture):
// the sanitize block spans the `sanitizeModule(...)` / `_G[...] = nil` lines.
const PRISTINE_LF = [
  "--Initialization script for the Mission lua Environment (SSE)",
  "",
  "dofile('Scripts/ScriptingSystem.lua')",
  "",
  "--Sanitize Mission Scripting environment",
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

/** The line index just before the sanitize block's first line ("do"). */
const FIRST_BLOCK_LINE = "do";

describe("trigger constants", () => {
  it("name the managed aggregator files inside a lfs.writedir() dofile", () => {
    expect(BEFORE_TRIGGER).toBe(`dofile(lfs.writedir()..'Scripts/${BEFORE_SANITIZE_FILE}')`);
    expect(AFTER_TRIGGER).toBe(`dofile(lfs.writedir()..'Scripts/${AFTER_SANITIZE_FILE}')`);
    expect(BEFORE_SANITIZE_FILE).toBe("DcsStudioMissionScriptsBeforeSanitize.lua");
    expect(AFTER_SANITIZE_FILE).toBe("DcsStudioMissionScriptsAfterSanitize.lua");
  });
});

describe("isBeforeTrigger / isAfterTrigger", () => {
  it("matches the canonical trigger lines (with surrounding whitespace)", () => {
    expect(isBeforeTrigger(BEFORE_TRIGGER)).toBe(true);
    expect(isBeforeTrigger(`   ${BEFORE_TRIGGER}  `)).toBe(true);
    expect(isAfterTrigger(AFTER_TRIGGER)).toBe(true);
  });
  it("tolerates a differently-quoted dofile naming the same file", () => {
    expect(isBeforeTrigger(`dofile(lfs.writedir().."Scripts/${BEFORE_SANITIZE_FILE}")`)).toBe(true);
  });
  it("does not cross-match the two triggers", () => {
    expect(isAfterTrigger(BEFORE_TRIGGER)).toBe(false);
    expect(isBeforeTrigger(AFTER_TRIGGER)).toBe(false);
  });
  it("rejects a non-dofile line and an unrelated dofile", () => {
    expect(isBeforeTrigger("print('hi')")).toBe(false);
    expect(isBeforeTrigger("dofile('Scripts/ScriptingSystem.lua')")).toBe(false);
    expect(isAfterTrigger("-- a comment mentioning DcsStudioMissionScriptsAfterSanitize.lua")).toBe(
      false,
    );
  });
});

describe("triggerStatus", () => {
  it("reports both missing on a pristine file with the sanitize block", () => {
    expect(triggerStatus(PRISTINE_LF)).toEqual({ before: "missing", after: "missing" });
  });

  it("reports both valid once installed", () => {
    const { content } = installTriggers(PRISTINE_LF);
    expect(triggerStatus(content)).toEqual({ before: "valid", after: "valid" });
  });

  it("detects a wrong-position before trigger (placed after the block)", () => {
    const lines = PRISTINE_LF.split("\n");
    lines.push(BEFORE_TRIGGER); // after the block → wrong for a before trigger
    expect(triggerStatus(lines.join("\n")).before).toBe("wrong-position");
  });

  it("detects a wrong-position after trigger (placed before the block)", () => {
    const lines = PRISTINE_LF.split("\n");
    lines.unshift(AFTER_TRIGGER); // before the block → wrong for an after trigger
    expect(triggerStatus(lines.join("\n")).after).toBe("wrong-position");
  });

  it("treats a present trigger as valid when the file has no sanitize block", () => {
    const noBlock = `print('nothing here')\n${BEFORE_TRIGGER}\n${AFTER_TRIGGER}\n`;
    expect(triggerStatus(noBlock)).toEqual({ before: "valid", after: "valid" });
  });

  it("reports missing on a block-less file with no triggers", () => {
    expect(triggerStatus("print('x')\n")).toEqual({ before: "missing", after: "missing" });
  });
});

describe("installTriggers", () => {
  it("inserts the before line above and the after line below the sanitize block", () => {
    const { content, changed } = installTriggers(PRISTINE_LF);
    expect(changed).toBe(true);
    const lines = content.split("\n");
    const before = lines.indexOf(BEFORE_TRIGGER);
    const after = lines.indexOf(AFTER_TRIGGER);
    const doIdx = lines.indexOf(FIRST_BLOCK_LINE);
    const endIdx = lines.lastIndexOf("end");
    expect(before).toBeGreaterThanOrEqual(0);
    expect(before).toBeLessThan(doIdx);
    expect(after).toBeGreaterThan(endIdx);
    // The lockdown lines survive verbatim.
    expect(content).toContain("\tsanitizeModule('os')");
  });

  it("is idempotent — re-running an already-correct file changes nothing", () => {
    const once = installTriggers(PRISTINE_LF).content;
    const twice = installTriggers(once);
    expect(twice.changed).toBe(false);
    expect(twice.content).toBe(once);
  });

  it("self-fixes a wrong-position trigger by relocating it", () => {
    const misplaced = `${PRISTINE_LF}\n${BEFORE_TRIGGER}`; // before-line after the block
    const { content } = installTriggers(misplaced);
    // Exactly one before line, now correctly above the block.
    const lines = content.split("\n");
    expect(lines.filter((l) => l === BEFORE_TRIGGER)).toHaveLength(1);
    expect(triggerStatus(content)).toEqual({ before: "valid", after: "valid" });
  });

  it("dedupes duplicate trigger lines", () => {
    const dupes = [BEFORE_TRIGGER, BEFORE_TRIGGER, PRISTINE_LF, AFTER_TRIGGER].join("\n");
    const { content } = installTriggers(dupes);
    const lines = content.split("\n");
    expect(lines.filter((l) => l === BEFORE_TRIGGER)).toHaveLength(1);
    expect(lines.filter((l) => l === AFTER_TRIGGER)).toHaveLength(1);
  });

  it("preserves CRLF line endings", () => {
    const { content, changed } = installTriggers(PRISTINE_CRLF);
    expect(changed).toBe(true);
    expect(content).not.toMatch(/[^\r]\n/);
    expect(content).toContain(`${BEFORE_TRIGGER}\r\n`);
  });

  it("wraps bare lockdown statements (no do/end), crossing blanks but stopping at real code", () => {
    // Blank lines around the statements are crossed; the print(...) lines stop
    // the expansion — so the triggers hug the statement span, not the whole file.
    const bare = [
      "print('setup')",
      "",
      "sanitizeModule('os')",
      "_G['require'] = nil",
      "",
      "print('done')",
    ].join("\n");
    const { content, changed } = installTriggers(bare);
    expect(changed).toBe(true);
    expect(content.split("\n")).toEqual([
      "print('setup')",
      "",
      BEFORE_TRIGGER,
      "sanitizeModule('os')",
      "_G['require'] = nil",
      AFTER_TRIGGER,
      "",
      "print('done')",
    ]);
    expect(triggerStatus(content)).toEqual({ before: "valid", after: "valid" });
  });

  it("falls back to top/bottom when there is no sanitize block", () => {
    const { content, changed } = installTriggers("print('a')\nprint('b')\n");
    expect(changed).toBe(true);
    const lines = content.split("\n");
    expect(lines[0]).toBe(BEFORE_TRIGGER);
    expect(lines[lines.length - 1]).toBe(AFTER_TRIGGER);
    expect(triggerStatus(content)).toEqual({ before: "valid", after: "valid" });
  });
});

describe("removeTriggers", () => {
  it("removes both trigger lines, leaving the rest intact", () => {
    const installed = installTriggers(PRISTINE_LF).content;
    const { content, changed } = removeTriggers(installed);
    expect(changed).toBe(true);
    expect(content).toBe(PRISTINE_LF);
    expect(triggerStatus(content)).toEqual({ before: "missing", after: "missing" });
  });

  it("reports changed=false when there are no triggers to remove", () => {
    const { content, changed } = removeTriggers(PRISTINE_LF);
    expect(changed).toBe(false);
    expect(content).toBe(PRISTINE_LF);
  });

  it("preserves CRLF while removing", () => {
    const installed = installTriggers(PRISTINE_CRLF).content;
    const { content } = removeTriggers(installed);
    expect(content).toBe(PRISTINE_CRLF);
  });
});
