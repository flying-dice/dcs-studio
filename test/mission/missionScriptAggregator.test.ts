import { describe, expect, it } from "vitest";
import {
  AFTER_SANITIZE_FILE,
  type AggregatorEntry,
  BEFORE_SANITIZE_FILE,
  generateAggregator,
  toPosix,
} from "../../src/core/domain/missionScriptAggregator";

describe("aggregator file names", () => {
  it("re-exports the managed file names", () => {
    expect(BEFORE_SANITIZE_FILE).toBe("DcsStudioMissionScriptsBeforeSanitize.lua");
    expect(AFTER_SANITIZE_FILE).toBe("DcsStudioMissionScriptsAfterSanitize.lua");
  });
});

describe("toPosix", () => {
  it("converts Windows backslashes to forward slashes", () => {
    expect(toPosix("C:\\Users\\me\\Saved Games\\DCS\\Scripts\\a.lua")).toBe(
      "C:/Users/me/Saved Games/DCS/Scripts/a.lua",
    );
  });
  it("leaves already-posix paths untouched", () => {
    expect(toPosix("C:/x/y.lua")).toBe("C:/x/y.lua");
  });
});

describe("generateAggregator", () => {
  it("emits a guard-only file for an empty entry set (never deleted)", () => {
    const out = generateAggregator([]);
    expect(out).toContain("local function dofileifexist(path)");
    expect(out).toContain("env.info");
    expect(out).toContain("env.warning");
    // No dofileifexist call lines when there are no entries.
    expect(out).not.toContain("dofileifexist([[");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("emits one guarded dofile per entry, tagged with the owning mod", () => {
    const entries: AggregatorEntry[] = [
      { tag: "owner/one@v1.0.0", absPath: "C:\\data\\one\\Scripts\\a.lua" },
      { tag: "owner/two@v2.3.1", absPath: "C:\\data\\two\\Scripts\\b.lua" },
    ];
    const out = generateAggregator(entries);
    expect(out).toContain("-- owner/one@v1.0.0\ndofileifexist([[C:/data/one/Scripts/a.lua]])");
    expect(out).toContain("-- owner/two@v2.3.1\ndofileifexist([[C:/data/two/Scripts/b.lua]])");
  });

  it("converts backslash paths to forward slashes inside the [[ ]] long string", () => {
    const out = generateAggregator([{ tag: "o/r@v1", absPath: "D:\\a\\b\\c.lua" }]);
    expect(out).toContain("dofileifexist([[D:/a/b/c.lua]])");
    expect(out).not.toContain("\\");
  });

  it("declares the guard before any entries", () => {
    const out = generateAggregator([{ tag: "o/r@v1", absPath: "x/a.lua" }]);
    expect(out.indexOf("local function dofileifexist")).toBeLessThan(
      out.indexOf("dofileifexist([["),
    );
  });
});
