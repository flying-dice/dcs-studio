import { describe, expect, it } from "vitest";
import {
  compareVersions,
  INSTALL_DIR,
  parseFrontmatter,
  requiresOverwriteConfirm,
  type SkillStatus,
  skillInfoFor,
} from "../../src/core/domain/skillsStatus";

describe("INSTALL_DIR", () => {
  it("is the frozen in-repo install path", () => {
    expect(INSTALL_DIR).toBe(".claude/skills");
  });
});

describe("parseFrontmatter", () => {
  it("parses name/description/version out of a well-formed block", () => {
    const fm = parseFrontmatter(
      "---\nname: My Skill\ndescription: Does things\nversion: 1.2.3\n---\n# Body\n",
    );
    expect(fm).toEqual({ name: "My Skill", description: "Does things", version: "1.2.3" });
  });

  it("returns {} when the text does not start with a fence", () => {
    expect(parseFrontmatter("# Just markdown\nname: nope\n")).toEqual({});
    expect(parseFrontmatter("")).toEqual({});
    // Leading whitespace before the fence also disqualifies it.
    expect(parseFrontmatter("\n---\nversion: 1\n---\n")).toEqual({});
    // A fence must be followed by a newline ("---x" is not a fence).
    expect(parseFrontmatter("--- \nversion: 1\n---\n")).toEqual({});
  });

  it("returns {} when the closing fence is missing", () => {
    expect(parseFrontmatter("---\nname: X\nversion: 1.0\n")).toEqual({});
  });

  it("finds a closing fence that starts a trailing line without a newline after it", () => {
    // indexOf("\n---") matches the final fence even with no trailing newline.
    expect(parseFrontmatter("---\nversion: 2.0\n---")).toEqual({ version: "2.0" });
  });

  it("treats an immediately-repeated fence as unclosed (characterised)", () => {
    // "---\n---\n..." — the search for "\n---" starts at index 4, past the
    // only occurrence, so the block reads as unclosed.
    expect(parseFrontmatter("---\n---\nversion: 1\n")).toEqual({});
  });

  it("handles CRLF line endings", () => {
    const fm = parseFrontmatter("---\r\nname: CRLF Skill\r\nversion: 0.2.0\r\n---\r\nbody\r\n");
    expect(fm).toEqual({ name: "CRLF Skill", version: "0.2.0" });
  });

  it("strips one layer of single or double quotes", () => {
    const fm = parseFrontmatter("---\nname: \"Quoted\"\ndescription: 'Single'\n---\n");
    expect(fm).toEqual({ name: "Quoted", description: "Single" });
  });

  it("strips mismatched edge quotes too (characterised)", () => {
    expect(parseFrontmatter("---\nname: \"Mismatch'\n---\n")).toEqual({ name: "Mismatch" });
  });

  it("keeps non-string YAML values as trimmed strings", () => {
    const fm = parseFrontmatter("---\nversion: 1.2\ndescription: [a, b]\nname: 42\n---\n");
    expect(fm).toEqual({ version: "1.2", description: "[a, b]", name: "42" });
  });

  it("parses an empty value as the empty string", () => {
    expect(parseFrontmatter("---\nversion:\n---\n")).toEqual({ version: "" });
    expect(parseFrontmatter("---\nversion:   \n---\n")).toEqual({ version: "" });
  });

  it("ignores unknown keys, comments, nested keys and malformed lines", () => {
    const fm = parseFrontmatter(
      "---\nauthor: someone\n# comment\n  name: indented ignored\nname: Kept\nnot a mapping\n---\n",
    );
    expect(fm).toEqual({ name: "Kept" });
  });

  it("last duplicate key wins", () => {
    expect(parseFrontmatter("---\nversion: 1.0\nversion: 2.0\n---\n")).toEqual({
      version: "2.0",
    });
  });
});

describe("compareVersions (dotted-numeric, characterised)", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("0.0.0", "0.0.0")).toBe(0);
  });

  it("compares numerically per segment (not lexically)", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "10.0.0")).toBeLessThan(0);
  });

  it("pads unequal lengths with zeros", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.1")).toBeLessThan(0);
    expect(compareVersions("1.2.1", "1.2")).toBeGreaterThan(0);
    expect(compareVersions("1", "1.0.0.0")).toBe(0);
  });

  it("treats fully non-numeric segments as 0", () => {
    expect(compareVersions("abc", "0")).toBe(0);
    expect(compareVersions("1.abc", "1.0")).toBe(0);
    expect(compareVersions("abc", "1")).toBeLessThan(0);
    // "v2" parses to 0, so a plain "1" beats it.
    expect(compareVersions("v2", "1")).toBeLessThan(0);
  });

  it("parseInt keeps a leading numeric prefix of a mixed segment", () => {
    expect(compareVersions("2a", "1")).toBeGreaterThan(0);
    expect(compareVersions("1.2rc1", "1.2")).toBe(0);
  });

  it("treats empty strings/segments as 0", () => {
    expect(compareVersions("", "")).toBe(0);
    expect(compareVersions("", "0.0")).toBe(0);
    expect(compareVersions("1..1", "1.0.1")).toBe(0);
  });

  it("returns the signed segment difference", () => {
    expect(compareVersions("1.4.0", "1.2.0")).toBe(2);
    expect(compareVersions("1.2.0", "1.4.0")).toBe(-2);
  });
});

describe("skillInfoFor (status state machine)", () => {
  const bundled = "---\nname: Pre-Commit\ndescription: Gate\nversion: 1.2.0\n---\n# Skill body\n";

  it("no workspace: no-workspace, bundled metadata only", () => {
    expect(skillInfoFor("pre-commit", bundled, false, undefined)).toEqual({
      id: "pre-commit",
      name: "Pre-Commit",
      description: "Gate",
      bundledVersion: "1.2.0",
      status: "no-workspace",
    });
  });

  it("no workspace ignores any installed text (probe order irrelevant)", () => {
    expect(skillInfoFor("pre-commit", bundled, false, bundled).status).toBe("no-workspace");
  });

  it("workspace but not installed: not-installed, no installedVersion", () => {
    const info = skillInfoFor("pre-commit", bundled, true, undefined);
    expect(info.status).toBe("not-installed");
    expect(info.installedVersion).toBeUndefined();
  });

  it("identical installed copy: up-to-date", () => {
    const info = skillInfoFor("pre-commit", bundled, true, bundled);
    expect(info.status).toBe("up-to-date");
    expect(info.installedVersion).toBe("1.2.0");
  });

  it("identical modulo CRLF: still up-to-date (both sides normalised)", () => {
    const crlf = bundled.replace(/\n/g, "\r\n");
    expect(skillInfoFor("pre-commit", bundled, true, crlf).status).toBe("up-to-date");
    expect(skillInfoFor("pre-commit", crlf, true, bundled).status).toBe("up-to-date");
  });

  it("older installed version: outdated (content diff not consulted)", () => {
    const older = bundled.replace("version: 1.2.0", "version: 1.1.9");
    const info = skillInfoFor("pre-commit", bundled, true, older);
    expect(info.status).toBe("outdated");
    expect(info.bundledVersion).toBe("1.2.0");
    expect(info.installedVersion).toBe("1.1.9");
  });

  it("same version, edited content: modified", () => {
    const edited = `${bundled}\nLocal tweak.\n`;
    expect(skillInfoFor("pre-commit", bundled, true, edited).status).toBe("modified");
  });

  it("newer installed version: modified when content differs, never outdated", () => {
    const newer = bundled.replace("version: 1.2.0", "version: 2.0.0");
    expect(skillInfoFor("pre-commit", bundled, true, newer).status).toBe("modified");
  });

  it("missing frontmatter falls back to id / empty description / 0.0.0 versions", () => {
    const bare = "# no frontmatter\n";
    const info = skillInfoFor("mystery", bare, true, bare);
    expect(info).toEqual({
      id: "mystery",
      name: "mystery",
      description: "",
      bundledVersion: "0.0.0",
      installedVersion: "0.0.0",
      status: "up-to-date",
    });
  });

  it("installed copy missing a version counts as 0.0.0 → outdated vs any newer bundle", () => {
    const installed = "---\nname: Pre-Commit\n---\nbody\n";
    const info = skillInfoFor("pre-commit", bundled, true, installed);
    expect(info.installedVersion).toBe("0.0.0");
    expect(info.status).toBe("outdated");
  });

  it("bundle missing a version (0.0.0) vs installed 0.0.0 with same text: up-to-date", () => {
    const noVersion = "---\nname: X\n---\nbody\n";
    expect(skillInfoFor("x", noVersion, true, noVersion).status).toBe("up-to-date");
  });
});

describe("requiresOverwriteConfirm", () => {
  it("asks only when the installed copy is modified", () => {
    const matrix: Record<SkillStatus, boolean> = {
      "no-workspace": false,
      "not-installed": false,
      "up-to-date": false,
      outdated: false,
      modified: true,
    };
    for (const [status, expected] of Object.entries(matrix)) {
      expect(requiresOverwriteConfirm(status as SkillStatus)).toBe(expected);
    }
  });
});
