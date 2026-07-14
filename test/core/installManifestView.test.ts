import { describe, expect, it } from "vitest";
import {
  deriveInstallManifestView,
  type InstallManifestInput,
} from "../../src/core/domain/installManifestView";

// The pure product-page / My Mods view-model: normalized sections, counts, and
// the ordered risk flags a subscriber must see before installing. Every branch
// (unknown state, optional-field defaulting, each risk flag) is exercised so the
// per-file coverage gate holds.

const empty: InstallManifestInput = {
  bundles: [],
  symlinks: [],
  entrypoints: [],
  missionScripts: [],
};

describe("deriveInstallManifestView — unknown state", () => {
  it("returns the explicit unknown view for a null surface", () => {
    const v = deriveInstallManifestView(null);
    expect(v).toEqual({
      known: false,
      bundles: [],
      symlinks: [],
      entrypoints: [],
      missionScripts: [],
      counts: { bundles: 0, symlinks: 0, entrypoints: 0, missionScripts: 0, beforeSanitize: 0 },
      risks: [],
    });
  });

  it("returns a fresh object each call (no shared mutable state)", () => {
    const a = deriveInstallManifestView(null);
    const b = deriveInstallManifestView(null);
    expect(a).not.toBe(b);
    expect(a.risks).not.toBe(b.risks);
  });
});

describe("deriveInstallManifestView — known but empty", () => {
  it("is known with zero counts and no risks", () => {
    const v = deriveInstallManifestView(empty);
    expect(v.known).toBe(true);
    expect(v.counts).toEqual({
      bundles: 0,
      symlinks: 0,
      entrypoints: 0,
      missionScripts: 0,
      beforeSanitize: 0,
    });
    expect(v.risks).toEqual([]);
  });
});

describe("deriveInstallManifestView — sections", () => {
  it("normalizes bundles, symlinks (resolved present + absent), entrypoints, mission scripts", () => {
    const v = deriveInstallManifestView({
      bundles: [{ path: "Scripts/mod" }, { path: "Server" }],
      symlinks: [
        {
          source: "Scripts/mod/a.lua",
          dest: "{SavedGames}/Scripts/a.lua",
          resolved: "C:\\SG\\Scripts\\a.lua",
        },
        { source: "Scripts/mod/b.lua", dest: "{GameInstall}/Scripts/b.lua" }, // no resolved → null
      ],
      entrypoints: [
        { id: "srs", name: "SRS Server", exe: "Server/SR.exe", args: ["--min"], cwd: "Server" },
        { id: "bare", name: "Bare", exe: "tool.exe" }, // no args/cwd → [] / null
      ],
      missionScripts: [
        {
          name: "After",
          purpose: "loads framework",
          path: "Scripts/after.lua",
          run_on: "after-sanitize",
        },
        { name: "Before", path: "Scripts/before.lua", run_on: "before-sanitize" }, // no purpose → null
      ],
    });

    expect(v.bundles).toEqual([{ path: "Scripts/mod" }, { path: "Server" }]);
    expect(v.symlinks).toEqual([
      {
        source: "Scripts/mod/a.lua",
        dest: "{SavedGames}/Scripts/a.lua",
        resolved: "C:\\SG\\Scripts\\a.lua",
      },
      { source: "Scripts/mod/b.lua", dest: "{GameInstall}/Scripts/b.lua", resolved: null },
    ]);
    expect(v.entrypoints).toEqual([
      { id: "srs", name: "SRS Server", exe: "Server/SR.exe", args: ["--min"], cwd: "Server" },
      { id: "bare", name: "Bare", exe: "tool.exe", args: [], cwd: null },
    ]);
    expect(v.missionScripts).toEqual([
      {
        name: "After",
        purpose: "loads framework",
        path: "Scripts/after.lua",
        run_on: "after-sanitize",
        beforeSanitize: false,
      },
      {
        name: "Before",
        purpose: null,
        path: "Scripts/before.lua",
        run_on: "before-sanitize",
        beforeSanitize: true,
      },
    ]);
    expect(v.counts).toEqual({
      bundles: 2,
      symlinks: 2,
      entrypoints: 2,
      missionScripts: 2,
      beforeSanitize: 1,
    });
  });

  it("treats an explicit null resolved the same as absent", () => {
    const v = deriveInstallManifestView({
      ...empty,
      symlinks: [{ source: "s", dest: "d", resolved: null }],
    });
    expect(v.symlinks[0].resolved).toBeNull();
  });
});

describe("deriveInstallManifestView — risk flags", () => {
  it("flags links-files only when there are symlinks", () => {
    const v = deriveInstallManifestView({ ...empty, symlinks: [{ source: "s", dest: "d" }] });
    expect(v.risks).toEqual(["links-files"]);
  });

  it("flags runs-executable only when there are entrypoints", () => {
    const v = deriveInstallManifestView({
      ...empty,
      entrypoints: [{ id: "x", name: "X", exe: "x.exe" }],
    });
    expect(v.risks).toEqual(["runs-executable"]);
  });

  it("flags pre-sanitize-script for before-sanitize scripts, not after-sanitize", () => {
    const after = deriveInstallManifestView({
      ...empty,
      missionScripts: [{ name: "A", path: "a.lua", run_on: "after-sanitize" }],
    });
    expect(after.risks).toEqual([]);
    expect(after.counts.beforeSanitize).toBe(0);

    const before = deriveInstallManifestView({
      ...empty,
      missionScripts: [{ name: "B", path: "b.lua", run_on: "before-sanitize" }],
    });
    expect(before.risks).toEqual(["pre-sanitize-script"]);
    expect(before.counts.beforeSanitize).toBe(1);
  });

  it("orders risks links-files, runs-executable, pre-sanitize-script", () => {
    const v = deriveInstallManifestView({
      bundles: [{ path: "p" }],
      symlinks: [{ source: "s", dest: "d" }],
      entrypoints: [{ id: "x", name: "X", exe: "x.exe" }],
      missionScripts: [{ name: "B", path: "b.lua", run_on: "before-sanitize" }],
    });
    expect(v.risks).toEqual(["links-files", "runs-executable", "pre-sanitize-script"]);
  });
});
