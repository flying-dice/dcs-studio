import { describe, it, expect } from "vitest";
import {
  MAX_VOLUME_BYTES,
  DEFAULT_VOLUME_BYTES,
  selectPayloadVolumes,
  volumeLimit,
  shouldSplit,
  isVolumeFamilyMember,
  selectSplitVolumes,
  payloadBase,
} from "../../src/core/domain/archivePolicy";

describe("archivePolicy constants", () => {
  it("clamps to GitHub-safe sizes", () => {
    expect(MAX_VOLUME_BYTES).toBe(2 * 1024 * 1024 * 1024 - 128 * 1024 * 1024);
    expect(DEFAULT_VOLUME_BYTES).toBe(Math.round(1.5 * 1024 * 1024 * 1024));
    expect(DEFAULT_VOLUME_BYTES).toBeLessThan(MAX_VOLUME_BYTES);
  });
});

describe("selectPayloadVolumes", () => {
  it("keeps only .7z / .7z.NNN assets, sorted by name", () => {
    const assets = [
      { name: "base.7z.002" },
      { name: "dcs-studio.toml" },
      { name: "base.7z.001" },
      { name: "readme.md" },
      { name: "single.7Z" }, // case-insensitive
    ];
    expect(selectPayloadVolumes(assets).map((a) => a.name)).toEqual([
      "base.7z.001",
      "base.7z.002",
      "single.7Z",
    ]);
  });

  it("returns empty when there are no payload volumes", () => {
    expect(selectPayloadVolumes([{ name: "dcs-studio.toml" }])).toEqual([]);
  });

  it("rejects a 4-digit volume suffix (only NNN matches)", () => {
    expect(selectPayloadVolumes([{ name: "base.7z.0001" }])).toEqual([]);
  });
});

describe("volumeLimit", () => {
  it("defaults to the default volume size", () => {
    expect(volumeLimit()).toBe(DEFAULT_VOLUME_BYTES);
  });

  it("honours a smaller override", () => {
    expect(volumeLimit(1000)).toBe(1000);
  });

  it("never exceeds the GitHub-safe maximum", () => {
    expect(volumeLimit(MAX_VOLUME_BYTES + 5000)).toBe(MAX_VOLUME_BYTES);
  });
});

describe("shouldSplit", () => {
  it("is false at or below the limit", () => {
    expect(shouldSplit(1000, 1000)).toBe(false);
    expect(shouldSplit(999, 1000)).toBe(false);
  });

  it("is true above the limit", () => {
    expect(shouldSplit(1001, 1000)).toBe(true);
  });

  it("uses the default limit when none is given", () => {
    expect(shouldSplit(DEFAULT_VOLUME_BYTES)).toBe(false);
    expect(shouldSplit(DEFAULT_VOLUME_BYTES + 1)).toBe(true);
  });
});

describe("isVolumeFamilyMember", () => {
  it("matches the single archive and numbered volumes", () => {
    expect(isVolumeFamilyMember("mod.7z", "mod")).toBe(true);
    expect(isVolumeFamilyMember("mod.7z.001", "mod")).toBe(true);
  });

  it("rejects unrelated files and other bases", () => {
    expect(isVolumeFamilyMember("mod.zip", "mod")).toBe(false);
    expect(isVolumeFamilyMember("other.7z", "mod")).toBe(false);
  });
});

describe("selectSplitVolumes", () => {
  it("returns numbered volumes for the base, sorted", () => {
    const names = ["mod.7z.003", "mod.7z", "mod.7z.001", "mod.7z.002", "other.7z.001"];
    expect(selectSplitVolumes(names, "mod")).toEqual(["mod.7z.001", "mod.7z.002", "mod.7z.003"]);
  });

  it("excludes the single .7z (no numeric suffix)", () => {
    expect(selectSplitVolumes(["mod.7z"], "mod")).toEqual([]);
  });
});

describe("payloadBase", () => {
  it("slugifies repo and tag", () => {
    expect(payloadBase("My Cool Mod", "v1.0.0")).toBe("dcs-studio-my-cool-mod-v1.0.0");
  });

  it("collapses runs of invalid characters and trims dashes", () => {
    expect(payloadBase("--A B!!C--", "@@tag@@")).toBe("dcs-studio-a-b-c-tag");
  });

  it("preserves allowed dot/underscore/hyphen characters", () => {
    expect(payloadBase("repo_1.2-x", "1_2.3")).toBe("dcs-studio-repo_1.2-x-1_2.3");
  });
});
