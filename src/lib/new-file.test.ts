import { describe, it, expect } from "vitest";
import { nextUntitledName } from "./new-file";

describe("nextUntitledName (File → New File naming, issue #59)", () => {
  it("uses the bare base name when nothing collides", () => {
    expect(nextUntitledName(new Set())).toBe("untitled.lua");
    expect(nextUntitledName(new Set(["main.lua", "README.md"]))).toBe(
      "untitled.lua",
    );
  });

  it("suffixes from 2 when the base name is taken", () => {
    expect(nextUntitledName(new Set(["untitled.lua"]))).toBe("untitled-2.lua");
    expect(
      nextUntitledName(new Set(["untitled.lua", "untitled-2.lua"])),
    ).toBe("untitled-3.lua");
  });

  it("folds case — a case-variant on disk still collides", () => {
    // Windows / macOS filesystems are case-insensitive: UNTITLED.LUA occupies
    // the same slot as untitled.lua, so the next free name must skip it.
    expect(nextUntitledName(new Set(["UNTITLED.LUA"]))).toBe("untitled-2.lua");
    expect(nextUntitledName(new Set(["Untitled-2.lua", "untitled.lua"]))).toBe(
      "untitled-3.lua",
    );
  });

  it("returns the first free slot, not one past the highest", () => {
    // A gap (no untitled-2) is filled rather than jumping to untitled-4.
    expect(
      nextUntitledName(new Set(["untitled.lua", "untitled-3.lua"])),
    ).toBe("untitled-2.lua");
  });
});
