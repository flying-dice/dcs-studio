import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  BAD_NAME,
  validateName,
  assertValidFolderName,
  assertLocationChosen,
  targetRoot,
  assertSafeRelative,
  assertRenderedSafe,
  assertNewFolderTarget,
  planInPlace,
  NewFolderProbe,
} from "../../src/core/domain/scaffoldPlan";
import type { TemplateFile } from "../../src/core/domain/projectTemplates";

describe("validateName", () => {
  it("returns the trimmed name", () => {
    expect(validateName("  My Mod  ")).toBe("My Mod");
    expect(validateName("x")).toBe("x");
  });

  it("rejects empty and whitespace-only names", () => {
    expect(() => validateName("")).toThrow("Enter a project name.");
    expect(() => validateName("   ")).toThrow("Enter a project name.");
    expect(() => validateName("\t\n")).toThrow("Enter a project name.");
  });
});

describe("assertValidFolderName", () => {
  it("accepts ordinary names", () => {
    expect(() => assertValidFolderName("My Mod")).not.toThrow();
    expect(() => assertValidFolderName("a.b-c_d 1")).not.toThrow();
  });

  it.each(["<", ">", ":", '"', "/", "\\", "|", "?", "*"])(
    "rejects the Windows-invalid character %s",
    (ch) => {
      expect(() => assertValidFolderName(`bad${ch}name`)).toThrow(
        `"bad${ch}name" isn't a valid folder name.`,
      );
    },
  );

  it("rejects control characters", () => {
    expect(() => assertValidFolderName("bad\x00name")).toThrow("isn't a valid folder name");
    expect(() => assertValidFolderName("bad\x1fname")).toThrow("isn't a valid folder name");
  });

  it("rejects a trailing dot or space (Windows)", () => {
    expect(() => assertValidFolderName("name.")).toThrow('"name." isn\'t a valid folder name.');
    expect(() => assertValidFolderName("name ")).toThrow("isn't a valid folder name");
  });

  it("allows inner dots and a leading dot", () => {
    expect(() => assertValidFolderName(".hidden")).not.toThrow();
    expect(() => assertValidFolderName("v1.2.3-x")).not.toThrow();
  });
});

describe("assertLocationChosen", () => {
  it("accepts a non-blank location", () => {
    expect(() => assertLocationChosen("C:\\projects")).not.toThrow();
  });

  it("rejects empty and whitespace-only locations", () => {
    expect(() => assertLocationChosen("")).toThrow("Choose a location for the project.");
    expect(() => assertLocationChosen("   ")).toThrow("Choose a location for the project.");
  });
});

describe("targetRoot", () => {
  it("joins parent and name with the platform separator", () => {
    expect(targetRoot("C:\\projects", "My Mod")).toBe(path.join("C:\\projects", "My Mod"));
  });
});

describe("assertSafeRelative (path-traversal guard)", () => {
  it("accepts plain and nested template paths", () => {
    expect(() => assertSafeRelative("dcs-studio.toml")).not.toThrow();
    expect(() => assertSafeRelative("Scripts/Hooks/mod_hook.lua")).not.toThrow();
    expect(() => assertSafeRelative(".cargo/config.toml")).not.toThrow();
  });

  it("rejects .. traversal anywhere in the path", () => {
    expect(() => assertSafeRelative("..")).toThrow("Template path escapes the project root: ..");
    expect(() => assertSafeRelative("../evil")).toThrow("escapes the project root");
    expect(() => assertSafeRelative("a/../b")).toThrow("escapes the project root");
    expect(() => assertSafeRelative("a/b/..")).toThrow("escapes the project root");
  });

  it("rejects absolute paths (POSIX and Windows forms)", () => {
    expect(() => assertSafeRelative("/etc/passwd")).toThrow("escapes the project root");
    expect(() => assertSafeRelative("C:/Windows/system32")).toThrow("escapes the project root");
    expect(() => assertSafeRelative("C:\\Windows\\system32")).toThrow("escapes the project root");
    expect(() => assertSafeRelative("\\\\server\\share\\x")).toThrow("escapes the project root");
  });

  it("rejects mixed-separator traversal (backslash components)", () => {
    // Split on "/" leaves "..\\evil" as one component; the backslash is a bad char.
    expect(() => assertSafeRelative("a/..\\evil")).toThrow("escapes the project root");
    expect(() => assertSafeRelative("a\\b/c")).toThrow("escapes the project root");
  });

  it("rejects . components, empty components and trailing slashes", () => {
    expect(() => assertSafeRelative("./a")).toThrow("escapes the project root");
    expect(() => assertSafeRelative("a/./b")).toThrow("escapes the project root");
    expect(() => assertSafeRelative("a//b")).toThrow("escapes the project root");
    expect(() => assertSafeRelative("a/")).toThrow("escapes the project root");
    expect(() => assertSafeRelative("")).toThrow("escapes the project root");
  });

  it("rejects components with Windows-invalid characters", () => {
    expect(() => assertSafeRelative("a/b:c")).toThrow("escapes the project root");
    expect(() => assertSafeRelative("a/b*")).toThrow("escapes the project root");
    expect(() => assertSafeRelative("con?/x")).toThrow("escapes the project root");
  });
});

describe("assertRenderedSafe", () => {
  const ok: TemplateFile[] = [
    { path: "dcs-studio.toml", contents: "x" },
    { path: "Scripts/a.lua", contents: "y" },
  ];

  it("throws the unknown-template error for undefined", () => {
    expect(() => assertRenderedSafe(undefined, "nope")).toThrow('Unknown template "nope".');
  });

  it("returns the files unchanged when all paths are safe", () => {
    expect(assertRenderedSafe(ok, "blank")).toBe(ok);
  });

  it("rejects a file set containing an escaping path", () => {
    const bad: TemplateFile[] = [...ok, { path: "../escape.txt", contents: "z" }];
    expect(() => assertRenderedSafe(bad, "blank")).toThrow("escapes the project root");
  });
});

describe("assertNewFolderTarget", () => {
  const root = "C:\\projects\\my-mod";

  it("allows an absent target", () => {
    expect(() => assertNewFolderTarget(root, { exists: false })).not.toThrow();
  });

  it("allows an existing empty directory", () => {
    const probe: NewFolderProbe = { exists: true, isDirectory: true, isEmpty: true };
    expect(() => assertNewFolderTarget(root, probe)).not.toThrow();
  });

  it("rejects an existing file at the path", () => {
    const probe: NewFolderProbe = { exists: true, isDirectory: false };
    expect(() => assertNewFolderTarget(root, probe)).toThrow(`"${root}" already exists.`);
  });

  it("rejects an existing non-empty directory", () => {
    const probe: NewFolderProbe = { exists: true, isDirectory: true, isEmpty: false };
    expect(() => assertNewFolderTarget(root, probe)).toThrow(
      `"${root}" already exists and isn't empty.`,
    );
  });
});

describe("planInPlace", () => {
  const a: TemplateFile = { path: "a.toml", contents: "1" };
  const b: TemplateFile = { path: "b/c.lua", contents: "2" };
  const c: TemplateFile = { path: "README.md", contents: "3" };

  it("skips existing files and writes the rest, preserving order", () => {
    const plan = planInPlace([
      { file: a, exists: true },
      { file: b, exists: false },
      { file: c, exists: true },
    ]);
    expect(plan.toWrite).toEqual([b]);
    expect(plan.skipped).toEqual(["a.toml", "README.md"]);
  });

  it("writes everything into an untouched folder", () => {
    const plan = planInPlace([
      { file: a, exists: false },
      { file: b, exists: false },
    ]);
    expect(plan.toWrite).toEqual([a, b]);
    expect(plan.skipped).toEqual([]);
  });

  it("skips everything when the folder already has all files", () => {
    const plan = planInPlace([
      { file: a, exists: true },
      { file: b, exists: true },
    ]);
    expect(plan.toWrite).toEqual([]);
    expect(plan.skipped).toEqual(["a.toml", "b/c.lua"]);
  });

  it("handles an empty file set", () => {
    expect(planInPlace([])).toEqual({ toWrite: [], skipped: [] });
  });
});

describe("BAD_NAME", () => {
  it("is the shared Windows-invalid character class", () => {
    expect(BAD_NAME.test("fine-name")).toBe(false);
    expect(BAD_NAME.test("a|b")).toBe(true);
  });
});
