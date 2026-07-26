import { describe, expect, it } from "vitest";
import {
  deriveInstallManifestView,
  type InstallManifestInput,
  unsafeManifestMessage,
  unsafeManifestPaths,
} from "../../../src/core/domain/installManifestView";

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
      unsafePaths: [],
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
        escapes: false,
      },
      {
        source: "Scripts/mod/b.lua",
        dest: "{GameInstall}/Scripts/b.lua",
        resolved: null,
        escapes: false,
      },
    ]);
    expect(v.entrypoints).toEqual([
      {
        id: "srs",
        name: "SRS Server",
        exe: "Server/SR.exe",
        args: ["--min"],
        cwd: "Server",
        escapes: false,
      },
      { id: "bare", name: "Bare", exe: "tool.exe", args: [], cwd: null, escapes: false },
    ]);
    expect(v.missionScripts).toEqual([
      {
        name: "After",
        purpose: "loads framework",
        path: "Scripts/after.lua",
        run_on: "after-sanitize",
        beforeSanitize: false,
        escapes: false,
      },
      {
        name: "Before",
        purpose: null,
        path: "Scripts/before.lua",
        run_on: "before-sanitize",
        beforeSanitize: true,
        escapes: false,
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

// ── containment (issue #16) ──────────────────────────────────────────────────
// The manifest arrives inside a stranger's release, so every declared path is
// measured against the shared predicate and the offenders are named. The
// predicate's own rules are covered in pathContainment.test.ts; what matters
// here is that each declaring site is checked, and that a row carrying an
// offender is flagged so the page can point at it.

describe("unsafeManifestPaths", () => {
  it("is empty for a surface whose every path stays under its root", () => {
    expect(
      unsafeManifestPaths({
        bundles: [{ path: "Scripts/mod" }],
        symlinks: [{ source: "Scripts/mod/a.lua", dest: "{SavedGames}/Scripts/a.lua" }],
        entrypoints: [{ id: "x", name: "X", exe: "Server/x.exe", cwd: "Server" }],
        missionScripts: [{ name: "M", path: "Scripts/m.lua", run_on: "after-sanitize" }],
      }),
    ).toEqual([]);
  });

  it("names a dest that walks up out of the DCS roots", () => {
    expect(
      unsafeManifestPaths({
        ...empty,
        symlinks: [{ source: "payload", dest: "{SavedGames}/../../Windows/System32/evil.dll" }],
      }),
    ).toEqual([
      {
        kind: "symlink-dest",
        value: "{SavedGames}/../../Windows/System32/evil.dll",
        reason:
          'Link destination "{SavedGames}/../../Windows/System32/evil.dll" reaches outside the configured DCS folders.',
      },
    ]);
  });

  it("names a dest asking for an NTFS alternate data stream", () => {
    const unsafe = unsafeManifestPaths({
      ...empty,
      symlinks: [{ source: "payload", dest: "{SavedGames}/notes.txt:hidden" }],
    });
    expect(unsafe.map((u) => u.kind)).toEqual(["symlink-dest"]);
  });

  it("names a source that walks up out of the mod's unpacked folder", () => {
    expect(
      unsafeManifestPaths({
        ...empty,
        symlinks: [{ source: "../../Windows/System32", dest: "{SavedGames}/Scripts/x" }],
      }),
    ).toEqual([
      {
        kind: "symlink-source",
        value: "../../Windows/System32",
        reason: 'Link source "../../Windows/System32" reaches outside the mod\'s own folder.',
      },
    ]);
  });

  it("reports both halves of a rule when both escape, dest first", () => {
    const unsafe = unsafeManifestPaths({
      ...empty,
      symlinks: [{ source: "../out", dest: "{SavedGames}/../out" }],
    });
    expect(unsafe.map((u) => u.kind)).toEqual(["symlink-dest", "symlink-source"]);
  });

  it("names an entrypoint exe and a declared cwd that escape", () => {
    const unsafe = unsafeManifestPaths({
      ...empty,
      entrypoints: [
        { id: "a", name: "A", exe: "../../Windows/System32/cmd.exe" },
        { id: "b", name: "B", exe: "Server/b.exe", cwd: "../.." },
      ],
    });
    expect(unsafe.map((u) => [u.kind, u.value])).toEqual([
      ["entrypoint-exe", "../../Windows/System32/cmd.exe"],
      ["entrypoint-cwd", "../.."],
    ]);
    expect(unsafe[1].reason).toBe(
      'Executable working directory "../.." reaches outside the mod\'s own folder.',
    );
  });

  it("ignores an absent cwd — it defaults to the exe's own directory", () => {
    expect(
      unsafeManifestPaths({ ...empty, entrypoints: [{ id: "a", name: "A", exe: "a.exe" }] }),
    ).toEqual([]);
  });

  it("names a mission script whose path escapes", () => {
    expect(
      unsafeManifestPaths({
        ...empty,
        missionScripts: [{ name: "M", path: "C:/evil.lua", run_on: "before-sanitize" }],
      }),
    ).toEqual([
      {
        kind: "mission-script-path",
        value: "C:/evil.lua",
        reason: 'Mission script "C:/evil.lua" reaches outside the mod\'s own folder.',
      },
    ]);
  });
});

describe("unsafeManifestMessage", () => {
  it("leads with what the mod asked for and then every reason", () => {
    const unsafe = unsafeManifestPaths({
      ...empty,
      symlinks: [{ source: "../a", dest: "{SavedGames}/../b" }],
    });
    expect(unsafeManifestMessage(unsafe)).toBe(
      "This mod's manifest asks to write outside your DCS folders. " +
        'Link destination "{SavedGames}/../b" reaches outside the configured DCS folders. ' +
        'Link source "../a" reaches outside the mod\'s own folder.',
    );
  });
});

describe("deriveInstallManifestView — containment", () => {
  it("carries the offending paths and flags only the rows that own them", () => {
    const v = deriveInstallManifestView({
      bundles: [{ path: "Scripts/mod" }],
      symlinks: [
        { source: "Scripts/mod/a.lua", dest: "{SavedGames}/Scripts/a.lua" },
        { source: "Scripts/mod/b.lua", dest: "{SavedGames}/../../evil" },
      ],
      entrypoints: [
        { id: "ok", name: "OK", exe: "Server/ok.exe" },
        { id: "bad", name: "Bad", exe: "../cmd.exe" },
      ],
      missionScripts: [
        { name: "ok", path: "Scripts/ok.lua", run_on: "after-sanitize" },
        { name: "bad", path: "../bad.lua", run_on: "after-sanitize" },
      ],
    });

    expect(v.symlinks.map((s) => s.escapes)).toEqual([false, true]);
    expect(v.entrypoints.map((e) => e.escapes)).toEqual([false, true]);
    expect(v.missionScripts.map((m) => m.escapes)).toEqual([false, true]);
    expect(v.unsafePaths.map((u) => u.kind)).toEqual([
      "symlink-dest",
      "entrypoint-exe",
      "mission-script-path",
    ]);
    // The sections and counts still render — the page shows what the mod WANTED
    // to do alongside the refusal, rather than hiding it.
    expect(v.known).toBe(true);
    expect(v.counts.symlinks).toBe(2);
  });

  it("flags a row whose source escapes even when its dest is fine", () => {
    const v = deriveInstallManifestView({
      ...empty,
      symlinks: [{ source: "../../etc", dest: "{SavedGames}/Scripts/x" }],
    });
    expect(v.symlinks[0].escapes).toBe(true);
  });

  it("flags an entrypoint whose declared cwd escapes even when its exe is fine", () => {
    const v = deriveInstallManifestView({
      ...empty,
      entrypoints: [{ id: "a", name: "A", exe: "Server/a.exe", cwd: "../.." }],
    });
    expect(v.entrypoints[0].escapes).toBe(true);
  });

  it("leaves the unknown view with no offending paths to report", () => {
    expect(deriveInstallManifestView(null).unsafePaths).toEqual([]);
  });
});
