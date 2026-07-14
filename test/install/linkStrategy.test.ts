import { describe, it, expect } from "vitest";
import {
  chooseLinkStrategy,
  sameVolume,
  shouldMergeInto,
  classifyExistingDest,
} from "../../src/core/domain/linkStrategy";

describe("sameVolume", () => {
  it("compares volume roots case-insensitively", () => {
    expect(sameVolume("C:\\a\\link", "c:\\b\\target")).toBe(true);
  });

  it("differs across drives", () => {
    expect(sameVolume("C:\\a\\link", "D:\\b\\target")).toBe(false);
  });
});

describe("chooseLinkStrategy", () => {
  it.each([
    // isWindows, isDir, sameVolume → strategy
    [false, true, true, "symlink-dir"],
    [false, true, false, "symlink-dir"],
    [false, false, true, "symlink-file"],
    [false, false, false, "symlink-file"],
    [true, true, true, "junction"],
    [true, true, false, "junction"],
    [true, false, true, "hardlink"],
    [true, false, false, "symlink-cross"],
  ] as const)(
    "isWindows=%s isDir=%s sameVolume=%s → %s",
    (isWindows, isDir, sameVol, expected) => {
      expect(chooseLinkStrategy({ isWindows, isDir, sameVolume: sameVol })).toBe(expected);
    },
  );
});

describe("shouldMergeInto", () => {
  it("merges only a real directory destination with a directory source", () => {
    expect(shouldMergeInto({ srcIsDir: true, destIsDir: true, destIsSymlink: false })).toBe(true);
  });

  it("does not merge when the source is a file", () => {
    expect(shouldMergeInto({ srcIsDir: false, destIsDir: true, destIsSymlink: false })).toBe(false);
  });

  it("does not merge when the destination is not a directory", () => {
    expect(shouldMergeInto({ srcIsDir: true, destIsDir: false, destIsSymlink: false })).toBe(false);
  });

  it("does not merge into a junction/symlink (lstat reports it as a symlink)", () => {
    expect(shouldMergeInto({ srcIsDir: true, destIsDir: true, destIsSymlink: true })).toBe(false);
  });
});

describe("classifyExistingDest", () => {
  it("merges into a real directory regardless of ownership", () => {
    expect(
      classifyExistingDest({ srcIsDir: true, destIsDir: true, destIsSymlink: false, ownedByUs: false }),
    ).toBe("merge");
  });

  it("adopts a link we already created (idempotent re-enable)", () => {
    expect(
      classifyExistingDest({ srcIsDir: true, destIsDir: true, destIsSymlink: true, ownedByUs: true }),
    ).toBe("adopt");
  });

  it("conflicts on a foreign destination we do not own", () => {
    expect(
      classifyExistingDest({ srcIsDir: false, destIsDir: false, destIsSymlink: false, ownedByUs: false }),
    ).toBe("conflict");
  });
});
