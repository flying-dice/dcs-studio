import { describe, expect, it } from "vitest";
import DcsManifestCore from "../../../media/manifest-core.js";

const { emptyModel, issues, parseToml } = DcsManifestCore;

// The manifest validation policy — what makes a dcs-studio.toml valid, and the
// exact sentence the author reads. It used to live in media/manifest.js, where
// only a browser could reach it; the rules are the same judgements publish
// preflight and the Rust parser make, so they are worth pinning down here at
// unit speed. The form (media/manifest.js) now only renders this list.

const ROOTS = { savedGames: "C:\\Users\\me\\Saved Games\\DCS", gameInstall: "D:\\DCS World" };
const NO_GAME_INSTALL = { savedGames: ROOTS.savedGames, gameInstall: "" };

/** A model with the required project name filled in, so a test isolates one rule. */
function named(over: Record<string, unknown> = {}) {
  const m = emptyModel();
  m.project.name = "my-mod";
  return { ...m, ...over };
}

describe("issues: [project]", () => {
  it("requires a project name, and treats whitespace as absent", () => {
    expect(issues(emptyModel(), ROOTS)).toContain("Project name is required.");
    expect(issues({ ...emptyModel(), project: { name: "   " } }, ROOTS)).toContain(
      "Project name is required.",
    );
  });

  it("reports nothing at all for a minimal, valid manifest", () => {
    expect(issues(named(), ROOTS)).toEqual([]);
  });
});

describe("issues: [[bundle]]", () => {
  it("names the 1-based row of an empty bundle path", () => {
    const m = named({ bundle: [{ path: "Scripts" }, { path: "" }] });
    expect(issues(m, ROOTS)).toEqual(["Bundle 2: path is empty."]);
  });
});

describe("issues: [[symlink]] bundle coverage", () => {
  it("rejects a source that is not inside any bundled path", () => {
    const m = named({
      bundle: [{ path: "Mods/tech/x" }],
      symlink: [{ source: "Scripts/loose.lua", dest: "{SavedGames}/Scripts/loose.lua" }],
    });
    expect(issues(m, ROOTS)).toEqual(["Symlink 1: source is not inside any bundled path."]);
  });

  it("accepts a source equal to, or nested under, a bundle path", () => {
    const m = named({
      bundle: [{ path: "Mods/tech/x" }],
      symlink: [
        { source: "Mods/tech/x", dest: "{SavedGames}/Mods/tech/x" },
        { source: "Mods/tech/x/entry.lua", dest: "{SavedGames}/Mods/tech/x/entry.lua" },
      ],
    });
    expect(issues(m, ROOTS)).toEqual([]);
  });

  it("compares separator-insensitively and ignores a trailing slash on the bundle path", () => {
    // Authors type Windows paths; the manifest is read on both. A bundle
    // written `Mods\tech\x\` must still cover `Mods/tech/x/entry.lua`.
    const m = named({
      bundle: [{ path: "Mods\\tech\\x\\" }],
      symlink: [{ source: "Mods/tech/x/entry.lua", dest: "{SavedGames}/e.lua" }],
    });
    expect(issues(m, ROOTS)).toEqual([]);
  });

  it("treats a project-root bundle (empty or '.') as covering everything", () => {
    for (const path of ["", "."]) {
      const m = named({
        bundle: [{ path }],
        symlink: [{ source: "anything/at/all.lua", dest: "{SavedGames}/a.lua" }],
      });
      // The empty path is still flagged as an empty bundle row, but it must not
      // ALSO produce a coverage complaint about every symlink under it.
      expect(issues(m, ROOTS)).not.toContain("Symlink 1: source is not inside any bundled path.");
    }
  });

  it("reports an empty source instead of an uncovered one", () => {
    const m = named({ symlink: [{ source: "  ", dest: "{SavedGames}/x" }] });
    expect(issues(m, ROOTS)).toEqual(["Symlink 1: source is empty."]);
  });
});

describe("issues: [[symlink]] dest containment", () => {
  it("calls an escaping dest an authoring error, on every machine", () => {
    // Refused at install time everywhere, so it must not be reported as the
    // machine-local {GameInstall} note even when that root is unset.
    const m = named({
      bundle: [{ path: "Scripts" }],
      symlink: [{ source: "Scripts/a.lua", dest: "{SavedGames}/../evil.lua" }],
    });
    expect(issues(m, NO_GAME_INSTALL)).toEqual([
      "Symlink 1: destination reaches outside the DCS folders.",
    ]);
  });

  it("reports an unconfigured {GameInstall} as a settings problem, with the setting id", () => {
    const m = named({
      bundle: [{ path: "Scripts" }],
      symlink: [{ source: "Scripts/a.lua", dest: "{GameInstall}/Scripts/a.lua" }],
    });
    expect(issues(m, NO_GAME_INSTALL)).toEqual([
      "Symlink 1: {GameInstall} is not configured (set dcsStudio.gameInstallPath).",
    ]);
    // Same manifest, machine with the root set: nothing to say.
    expect(issues(m, ROOTS)).toEqual([]);
  });
});

describe("issues: [[requires_module]]", () => {
  it("requires an id", () => {
    const m = named({ requires_module: [{ id: "F-16C_50", name: "" }, { id: "" }] });
    expect(issues(m, ROOTS)).toEqual(["Required module 2: id is empty."]);
  });
});

describe("issues: [[entrypoint]]", () => {
  it("requires an id and an exe", () => {
    const m = named({ entrypoint: [{ id: "", name: "", exe: "" }] });
    expect(issues(m, ROOTS)).toEqual(["Executable 1: id is empty.", "Executable 1: exe is empty."]);
  });

  it("flags only the LATER of two entrypoints sharing an id", () => {
    // Duplicate ids would make My Mods launch the wrong process; the first
    // occurrence is the keeper, so only the second row is the error.
    const m = named({
      bundle: [{ path: "Server" }],
      entrypoint: [
        { id: "dup", name: "A", exe: "Server/a.exe" },
        { id: "dup", name: "B", exe: "Server/b.exe" },
      ],
    });
    expect(issues(m, ROOTS)).toEqual(['Executable 2: duplicate id "dup".']);
  });

  it("requires the exe to sit inside a bundled path so it ships in the release", () => {
    const m = named({
      bundle: [{ path: "Scripts" }],
      entrypoint: [{ id: "srv", name: "Server", exe: "Server/a.exe" }],
    });
    expect(issues(m, ROOTS)).toEqual(["Executable 1: exe is not inside any bundled path."]);
  });
});

describe("issues: [[mission_script]]", () => {
  it("requires a name and a path, reporting both for one row", () => {
    const m = named({ mission_script: [{ name: "", path: "", run_on: "after-sanitize" }] });
    expect(issues(m, ROOTS)).toEqual([
      "Mission script 1: name is empty.",
      "Mission script 1: path is empty.",
    ]);
  });

  it("requires the path to sit inside a bundled path", () => {
    const m = named({
      bundle: [{ path: "Mods" }],
      mission_script: [{ name: "loader", path: "Scripts/loader.lua", run_on: "after-sanitize" }],
    });
    expect(issues(m, ROOTS)).toEqual(["Mission script 1: path is not inside any bundled path."]);
  });

  it("accepts a named script whose path is under a bundled path", () => {
    const m = named({
      bundle: [{ path: "Scripts" }],
      mission_script: [{ name: "loader", path: "Scripts/loader.lua", run_on: "before-sanitize" }],
    });
    // run_on is not validated here — the form offers only the two legal values,
    // and a before-sanitize script is a warning to the subscriber, not an error.
    expect(issues(m, ROOTS)).toEqual([]);
  });
});

describe("issues: over a parsed document", () => {
  it("reports every section's problems in document order", () => {
    const m = parseToml(`[project]
name = ""

[[bundle]]
path = "Mods/tech/x"

[[symlink]]
source = "Scripts/stray.lua"
dest = "{GameInstall}/Scripts/stray.lua"

[[requires_module]]
id = ""

[[entrypoint]]
id = ""
exe = ""

[[mission_script]]
name = ""
path = ""
`);
    expect(issues(m, NO_GAME_INSTALL)).toEqual([
      "Project name is required.",
      "Symlink 1: source is not inside any bundled path.",
      "Symlink 1: {GameInstall} is not configured (set dcsStudio.gameInstallPath).",
      "Required module 1: id is empty.",
      "Executable 1: id is empty.",
      "Executable 1: exe is empty.",
      "Mission script 1: name is empty.",
      "Mission script 1: path is empty.",
    ]);
  });
});
