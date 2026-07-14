import { describe, it, expect } from "vitest";
import {
  computeGhCheck,
  computePreflight,
  isCoveredByBundle,
  type PreflightFacts,
} from "../../src/core/domain/publishChecks";
import type { ManifestModel } from "../../src/core/domain/types";

function manifest(over: Partial<ManifestModel> = {}): ManifestModel {
  return {
    project: { name: "My Mod", version: "1.0.0", author: "me", description: "d" },
    bundle: [],
    symlink: [],
    requires_module: [],
    extras: [],
    ...over,
  };
}

/** Facts describing a fully green preflight; override per scenario. */
function facts(over: Partial<PreflightFacts> = {}): PreflightFacts {
  return {
    manifestExists: true,
    manifest: manifest(),
    bundle: [],
    sevenZip: "C:\\Program Files\\7-Zip\\7z.exe",
    gitAvailable: true,
    gh: { present: true, authed: true },
    ...over,
  };
}

function byLabel(checks: ReturnType<typeof computePreflight>, label: string) {
  return checks.find((c) => c.label === label);
}

describe("computePreflight — manifest checks", () => {
  it("errors when the manifest file is absent", () => {
    const checks = computePreflight(facts({ manifestExists: false, manifest: null }));
    expect(byLabel(checks, "Manifest")).toEqual({
      label: "Manifest",
      level: "error",
      detail: "dcs-studio.toml not found in the workspace root.",
    });
    // No project-name/bundle checks are possible without a manifest.
    expect(byLabel(checks, "Project name")).toBeUndefined();
    expect(byLabel(checks, "Bundle paths")).toBeUndefined();
  });

  it("errors when the manifest exists but does not parse", () => {
    const checks = computePreflight(facts({ manifest: null }));
    expect(byLabel(checks, "Manifest")).toEqual({
      label: "Manifest",
      level: "error",
      detail: "Could not parse dcs-studio.toml.",
    });
  });

  it("passes the project name through as the ok detail", () => {
    const checks = computePreflight(facts());
    expect(byLabel(checks, "Project name")).toEqual({ label: "Project name", level: "ok", detail: "My Mod" });
  });

  it("errors on a blank (whitespace-only) project name", () => {
    const m = manifest();
    m.project.name = "   ";
    const checks = computePreflight(facts({ manifest: m }));
    expect(byLabel(checks, "Project name")).toEqual({
      label: "Project name",
      level: "error",
      detail: "[project] name is required.",
    });
  });
});

describe("computePreflight — bundle paths", () => {
  it("warns when there are no [[bundle]] paths", () => {
    const checks = computePreflight(facts());
    expect(byLabel(checks, "Bundle paths")).toEqual({
      label: "Bundle paths",
      level: "warn",
      detail: "No [[bundle]] paths — the release will ship only the manifest.",
    });
  });

  it("is ok when every bundle path is present and none are symlinks", () => {
    const m = manifest({ bundle: [{ path: "out/a" }, { path: "out/b" }] });
    const checks = computePreflight(
      facts({
        manifest: m,
        bundle: [
          { source: "out/a", missing: false, symlink: false },
          { source: "out/b", missing: false, symlink: false },
        ],
      }),
    );
    expect(byLabel(checks, "Bundle paths")).toEqual({
      label: "Bundle paths",
      level: "ok",
      detail: "2 bundle path(s) present.",
    });
  });

  it("errors on missing bundle paths with a per-item breakdown", () => {
    const m = manifest({ bundle: [{ path: "out/a" }, { path: "out/b" }] });
    const checks = computePreflight(
      facts({
        manifest: m,
        bundle: [
          { source: "out/a", missing: true, symlink: false },
          { source: "out/b", missing: false, symlink: false },
        ],
      }),
    );
    expect(byLabel(checks, "Bundle paths")).toEqual({
      label: "Bundle paths",
      level: "error",
      detail: "1 of 2 bundle path(s) missing — build the project first.",
      items: ["missing: out/a"],
    });
  });

  it("errors on symlinked bundle paths when none are missing", () => {
    const m = manifest({ bundle: [{ path: "out/a" }, { path: "out/b" }] });
    const checks = computePreflight(
      facts({
        manifest: m,
        bundle: [
          { source: "out/a", missing: false, symlink: true },
          { source: "out/b", missing: false, symlink: false },
        ],
      }),
    );
    expect(byLabel(checks, "Bundle paths")).toEqual({
      label: "Bundle paths",
      level: "error",
      detail: "1 bundle path(s) are symlinks (refused by the packager).",
      items: ["symlink: out/a"],
    });
  });

  it("reports missing ahead of symlinks when both occur", () => {
    const m = manifest({ bundle: [{ path: "out/a" }, { path: "out/b" }] });
    const checks = computePreflight(
      facts({
        manifest: m,
        bundle: [
          { source: "out/a", missing: true, symlink: false },
          { source: "out/b", missing: false, symlink: true },
        ],
      }),
    );
    const c = byLabel(checks, "Bundle paths");
    expect(c?.detail).toBe("1 of 2 bundle path(s) missing — build the project first.");
    expect(c?.items).toEqual(["missing: out/a"]);
  });
});

describe("computePreflight — symlink coverage", () => {
  it("emits no coverage check when the manifest has no symlinks", () => {
    const checks = computePreflight(facts());
    expect(byLabel(checks, "Symlink coverage")).toBeUndefined();
  });

  it("is ok when every symlink source is inside a bundled path", () => {
    const m = manifest({
      bundle: [{ path: "Mods/tech/x" }],
      symlink: [
        { source: "Mods/tech/x", dest: "{SavedGames}/Mods/tech/x" },
        { source: "Mods/tech/x/entry.lua", dest: "{SavedGames}/Mods/tech/x/entry.lua" },
      ],
    });
    const checks = computePreflight(
      facts({ manifest: m, bundle: [{ source: "Mods/tech/x", missing: false, symlink: false }] }),
    );
    expect(byLabel(checks, "Symlink coverage")).toEqual({
      label: "Symlink coverage",
      level: "ok",
      detail: "2 symlink(s) covered by bundled content.",
    });
  });

  it("errors listing symlink sources not inside any bundle path", () => {
    const m = manifest({
      bundle: [{ path: "Mods/tech/x" }],
      symlink: [
        { source: "Mods/tech/x/entry.lua", dest: "{SavedGames}/a" },
        { source: "Scripts/orphan.lua", dest: "{SavedGames}/b" },
      ],
    });
    const checks = computePreflight(
      facts({ manifest: m, bundle: [{ source: "Mods/tech/x", missing: false, symlink: false }] }),
    );
    expect(byLabel(checks, "Symlink coverage")).toEqual({
      label: "Symlink coverage",
      level: "error",
      detail: "1 symlink source(s) not inside any [[bundle]] path.",
      items: ["not bundled: Scripts/orphan.lua"],
    });
  });
});

describe("isCoveredByBundle", () => {
  it("covers an exact match and a nested path", () => {
    expect(isCoveredByBundle("Mods/x", ["Mods/x"])).toBe(true);
    expect(isCoveredByBundle("Mods/x/entry.lua", ["Mods/x"])).toBe(true);
  });

  it("rejects a sibling that merely shares a prefix", () => {
    expect(isCoveredByBundle("Mods/xtra", ["Mods/x"])).toBe(false);
    expect(isCoveredByBundle("Scripts/a", ["Mods/x"])).toBe(false);
  });

  it("normalizes separators and trailing slashes", () => {
    expect(isCoveredByBundle("Mods\\x\\entry.lua", ["Mods/x/"])).toBe(true);
  });

  it("treats '.' or '' as the whole project (covers everything)", () => {
    expect(isCoveredByBundle("anything/here", ["."])).toBe(true);
    expect(isCoveredByBundle("anything/here", [""])).toBe(true);
  });
});

describe("computePreflight — tools", () => {
  it("reports the resolved 7-Zip path when available", () => {
    expect(byLabel(computePreflight(facts()), "7-Zip")).toEqual({
      label: "7-Zip",
      level: "ok",
      detail: "C:\\Program Files\\7-Zip\\7z.exe",
    });
  });

  it("errors when 7-Zip is unavailable", () => {
    expect(byLabel(computePreflight(facts({ sevenZip: null })), "7-Zip")).toEqual({
      label: "7-Zip",
      level: "error",
      detail: "7z not found. Install 7-Zip (7-zip.org) and retry.",
    });
  });

  it("reports git availability", () => {
    expect(byLabel(computePreflight(facts()), "git")).toEqual({ label: "git", level: "ok", detail: "available" });
    expect(byLabel(computePreflight(facts({ gitAvailable: false })), "git")).toEqual({
      label: "git",
      level: "error",
      detail: "git not found on PATH.",
    });
  });

  it("keeps the check order: manifest checks, 7-Zip, git, GitHub CLI", () => {
    const labels = computePreflight(facts()).map((c) => c.label);
    expect(labels).toEqual(["Project name", "Bundle paths", "7-Zip", "git", "GitHub CLI"]);
  });

  it("inserts symlink coverage right after bundle paths when symlinks exist", () => {
    const m = manifest({
      bundle: [{ path: "out/a" }],
      symlink: [{ source: "out/a", dest: "{SavedGames}/a" }],
    });
    const labels = computePreflight(
      facts({ manifest: m, bundle: [{ source: "out/a", missing: false, symlink: false }] }),
    ).map((c) => c.label);
    expect(labels).toEqual(["Project name", "Bundle paths", "Symlink coverage", "7-Zip", "git", "GitHub CLI"]);
  });
});

describe("computeGhCheck", () => {
  it("errors when gh is not installed", () => {
    expect(computeGhCheck({ present: false, authed: false })).toEqual({
      label: "GitHub CLI",
      level: "error",
      detail: "gh not found. Install from cli.github.com.",
    });
  });

  it("errors when gh is installed but signed out", () => {
    expect(computeGhCheck({ present: true, authed: false })).toEqual({
      label: "GitHub CLI",
      level: "error",
      detail: "gh is not signed in. Run: gh auth login",
    });
  });

  it("is ok when signed in", () => {
    expect(computeGhCheck({ present: true, authed: true })).toEqual({
      label: "GitHub CLI",
      level: "ok",
      detail: "signed in",
    });
  });

  it("is embedded as the final preflight check", () => {
    const checks = computePreflight(facts({ gh: { present: true, authed: false } }));
    expect(checks[checks.length - 1]).toEqual({
      label: "GitHub CLI",
      level: "error",
      detail: "gh is not signed in. Run: gh auth login",
    });
  });
});
