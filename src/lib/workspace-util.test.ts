import { describe, it, expect } from "vitest";
import { reconcileBuffer, fsKey } from "./workspace-util";

describe("reconcileBuffer (the fs-watcher reconcile machine, issue #40)", () => {
  it("no-ops when disk matches the saved baseline (our own save / a revert)", () => {
    // Clean buffer, disk == saved.
    expect(reconcileBuffer("v1", "v1", "v1")).toBe("noop");
    // Dirty buffer, but disk reverted to the saved baseline → not stale.
    expect(reconcileBuffer("v1", "edited", "v1")).toBe("noop");
  });

  it("reloads a CLEAN buffer when disk changed", () => {
    // docText === savedText (clean), disk differs.
    expect(reconcileBuffer("v1", "v1", "v2")).toBe("reload");
  });

  it("flags a DIRTY buffer stale when disk changed (never clobbers edits)", () => {
    // docText !== savedText (dirty), disk differs from both.
    expect(reconcileBuffer("v1", "my-edits", "external-v2")).toBe("stale");
  });

  it("prioritises the no-op so a save echo can't trigger a reload", () => {
    // The classic self-save: we just wrote `docText`, so saved===doc===disk.
    expect(reconcileBuffer("saved", "saved", "saved")).toBe("noop");
  });
});

describe("fsKey (watcher path ↔ tree identity normalization, issue #40)", () => {
  it("strips the Windows \\\\?\\ verbatim prefix", () => {
    expect(fsKey("\\\\?\\C:\\proj\\a.lua")).toBe(fsKey("C:\\proj\\a.lua"));
  });

  it("unifies separators so a `\\` path and a `/` path match", () => {
    expect(fsKey("C:\\proj\\src\\a.lua")).toBe(fsKey("C:/proj/src/a.lua"));
  });

  it("upper-cases a leading drive letter (Windows is case-insensitive there)", () => {
    expect(fsKey("c:\\proj\\a.lua")).toBe(fsKey("C:\\proj\\a.lua"));
    expect(fsKey("c:/proj/a.lua")).toBe("C:/proj/a.lua");
  });

  it("leaves a POSIX path untouched", () => {
    expect(fsKey("/home/u/proj/a.lua")).toBe("/home/u/proj/a.lua");
  });
});
