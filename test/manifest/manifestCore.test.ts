import { describe, it, expect } from "vitest";
import DcsManifestCore from "../../media/manifest-core.js";

const { parseToml, emitToml, MISSION_SCRIPT_RUN_ON } = DcsManifestCore;

// manifest-core splits packaging ([[bundle]]) from linking ([[symlink]]). The
// pre-release `[[install]]` section is NOT modeled: it is no different from any
// other unknown section — captured verbatim into `model.extras`, contributing
// nothing to bundle/symlink, and re-emitted unchanged (breaking change, 2026-07;
// see the [[dependencies]] passthrough tests below for the general behavior).

describe("manifest-core: [[install]] is unmodeled (falls through to extras)", () => {
  it("an [[install]]-only manifest parses with empty bundle/symlink", () => {
    const model = parseToml(`[project]
name = "my-mod"

[[install]]
source = "Scripts/a.lua"
dest = "{SavedGames}/Scripts/a.lua"

[[install]]
source = "Mods/tech/x"
dest = "{SavedGames}/Mods/tech/x"
`);
    // No `install` field is ever exposed downstream, and nothing is derived
    // from it into bundle/symlink — the section is functionally ignored.
    expect(model).not.toHaveProperty("install");
    expect(model.bundle).toEqual([]);
    expect(model.symlink).toEqual([]);
  });

  it("captures the [[install]] block verbatim into extras", () => {
    const model = parseToml(`[project]
name = "my-mod"

[[install]]
source = "Scripts/a.lua"
dest = "{SavedGames}/Scripts/a.lua"
`);
    expect(model.extras).toHaveLength(1);
    expect(model.extras[0]).toContain("[[install]]");
    expect(model.extras[0]).toContain('source = "Scripts/a.lua"');
    expect(model.extras[0]).toContain('dest = "{SavedGames}/Scripts/a.lua"');
  });

  it("new-only: explicit bundle/symlink blocks parse verbatim, no install involved", () => {
    const model = parseToml(`[project]
name = "my-mod"

[[bundle]]
path = "Mods/tech/f16-weapons"

[[symlink]]
source = "Mods/tech/f16-weapons/entry.lua"
dest = "{SavedGames}/Mods/tech/f16-weapons/entry.lua"
`);
    expect(model.bundle).toEqual([{ path: "Mods/tech/f16-weapons" }]);
    expect(model.symlink).toEqual([
      { source: "Mods/tech/f16-weapons/entry.lua", dest: "{SavedGames}/Mods/tech/f16-weapons/entry.lua" },
    ]);
  });

  it("mixed: explicit bundle/symlink blocks parse normally alongside an unrelated [[install]] extras block", () => {
    const model = parseToml(`[project]
name = "my-mod"

[[bundle]]
path = "Mods/tech/f16-weapons"

[[symlink]]
source = "Mods/tech/f16-weapons/entry.lua"
dest = "{SavedGames}/Mods/tech/f16-weapons/entry.lua"

[[install]]
source = "Scripts/legacy.lua"
dest = "{SavedGames}/Scripts/legacy.lua"
`);
    // The [[install]] rule contributes nothing to bundle/symlink — it is not
    // folded in, deduped against, or otherwise interpreted.
    expect(model.bundle).toEqual([{ path: "Mods/tech/f16-weapons" }]);
    expect(model.symlink).toEqual([
      { source: "Mods/tech/f16-weapons/entry.lua", dest: "{SavedGames}/Mods/tech/f16-weapons/entry.lua" },
    ]);
    expect(model.extras).toHaveLength(1);
    expect(model.extras[0]).toContain("[[install]]");
  });

  it("survives parse -> emit -> reparse with the [[install]] extras block unchanged (like [[dependencies]])", () => {
    const raw = `[project]
name = "my-mod"

[[install]]
source = "Scripts/a.lua"
dest = "{SavedGames}/Scripts/a.lua"
`;
    const model = parseToml(raw);
    const emitted = emitToml(model);

    // [[install]] round-trips verbatim — it is not rewritten into bundle/symlink.
    expect(emitted).toContain("[[install]]");
    expect(emitted).toContain('source = "Scripts/a.lua"');
    expect(emitted).toContain('dest = "{SavedGames}/Scripts/a.lua"');
    expect(emitted).not.toContain("[[bundle]]");
    expect(emitted).not.toContain("[[symlink]]");

    const reparsed = parseToml(emitted);
    expect(reparsed.extras).toEqual(model.extras);
    expect(reparsed.bundle).toEqual(model.bundle);
    expect(reparsed.symlink).toEqual(model.symlink);
  });

  it("an empty manifest yields empty bundle/symlink/entrypoint/mission_script arrays", () => {
    const model = parseToml("");
    expect(model.bundle).toEqual([]);
    expect(model.symlink).toEqual([]);
    expect(model.requires_module).toEqual([]);
    expect(model.entrypoint).toEqual([]);
    expect(model.mission_script).toEqual([]);
  });
});

describe("manifest-core: [[mission_script]] blocks", () => {
  it("exposes the two run_on values (safe default first)", () => {
    expect(MISSION_SCRIPT_RUN_ON).toEqual(["after-sanitize", "before-sanitize"]);
  });

  it("parses name/purpose/path/run_on", () => {
    const model = parseToml(`[project]
name = "framework"

[[bundle]]
path = "Scripts/fw"

[[mission_script]]
name = "Loader"
purpose = "Boots the framework"
path = "Scripts/fw/loader.lua"
run_on = "before-sanitize"
`);
    expect(model.mission_script).toEqual([
      { name: "Loader", purpose: "Boots the framework", path: "Scripts/fw/loader.lua", run_on: "before-sanitize" },
    ]);
  });

  it("defaults run_on to after-sanitize when omitted", () => {
    const model = parseToml(`[project]
name = "m"

[[mission_script]]
name = "S"
path = "Scripts/s.lua"
`);
    expect(model.mission_script[0].run_on).toBe("after-sanitize");
  });

  it("emits name/path/run_on always and purpose only when present, round-tripping stably", () => {
    const model = parseToml(`[project]
name = "m"

[[bundle]]
path = "Scripts"

[[mission_script]]
name = "A"
purpose = "does a"
path = "Scripts/a.lua"
run_on = "before-sanitize"

[[mission_script]]
name = "B"
path = "Scripts/b.lua"
run_on = "after-sanitize"
`);
    const emitted = emitToml(model);
    expect(emitted).toContain("[[mission_script]]");
    expect(emitted).toContain('name = "A"');
    expect(emitted).toContain('purpose = "does a"');
    expect(emitted).toContain('path = "Scripts/a.lua"');
    expect(emitted).toContain('run_on = "before-sanitize"');
    // The second block has no purpose — that line is omitted for it.
    expect(emitted).not.toContain('purpose = "does b"');
    const reparsed = parseToml(emitted);
    expect(reparsed.mission_script).toEqual(model.mission_script);
  });

  it("emits a fallback run_on for a block whose value is blank", () => {
    const model = parseToml(`[project]
name = "m"

[[mission_script]]
name = "A"
path = "Scripts/a.lua"
run_on = ""
`);
    expect(emitToml(model)).toContain('run_on = "after-sanitize"');
  });
});

describe("manifest-core: [[entrypoint]] blocks", () => {
  it("parses id/name/exe with optional args array + cwd", () => {
    const model = parseToml(`[project]
name = "DCS-SRS"

[[bundle]]
path = "Server"

[[entrypoint]]
id = "srs-server"
name = "SRS Server"
exe = "Server/SR-Server.exe"
args = ["--minimized", "-v"]
cwd = "Server"
`);
    expect(model.entrypoint).toEqual([
      { id: "srs-server", name: "SRS Server", exe: "Server/SR-Server.exe", args: ["--minimized", "-v"], cwd: "Server" },
    ]);
  });

  it("parses an entrypoint with no args and no cwd", () => {
    const model = parseToml(`[project]
name = "m"

[[entrypoint]]
id = "app"
name = "App"
exe = "bin/app.exe"
`);
    expect(model.entrypoint).toEqual([{ id: "app", name: "App", exe: "bin/app.exe" }]);
  });

  it("parses an empty args array as []", () => {
    const model = parseToml(`[project]
name = "m"

[[entrypoint]]
id = "app"
name = "App"
exe = "app.exe"
args = []
`);
    expect(model.entrypoint[0].args).toEqual([]);
  });

  it("emits id/name/exe always and args/cwd only when present, round-tripping stably", () => {
    const model = parseToml(`[project]
name = "m"

[[bundle]]
path = "bin"

[[entrypoint]]
id = "a"
name = "A"
exe = "bin/a.exe"
args = ["--flag"]
cwd = "bin"

[[entrypoint]]
id = "b"
name = "B"
exe = "bin/b.exe"
`);
    const emitted = emitToml(model);
    expect(emitted).toContain("[[entrypoint]]");
    expect(emitted).toContain('id = "a"');
    expect(emitted).toContain('exe = "bin/a.exe"');
    expect(emitted).toContain('args = ["--flag"]');
    expect(emitted).toContain('cwd = "bin"');
    // The second entrypoint has no args/cwd — those lines are omitted for it.
    const reparsed = parseToml(emitted);
    expect(reparsed.entrypoint).toEqual(model.entrypoint);
  });

  it("preserves {SavedGames}/{GameInstall} tokens inside args verbatim through round-trip", () => {
    const model = parseToml(`[project]
name = "m"

[[entrypoint]]
id = "a"
name = "A"
exe = "a.exe"
args = ["--sg", "{SavedGames}/x", "{GameInstall}/y"]
`);
    expect(model.entrypoint[0].args).toEqual(["--sg", "{SavedGames}/x", "{GameInstall}/y"]);
    const reparsed = parseToml(emitToml(model));
    expect(reparsed.entrypoint[0].args).toEqual(["--sg", "{SavedGames}/x", "{GameInstall}/y"]);
  });
});

// dcs-studio no longer models [[dependencies]] (that section belongs to the
// separate Lua-manager toolchain now) but manifest-core's job is to never drop
// what it doesn't model: an unmodeled `[[...]]` block is captured verbatim into
// `model.extras` and re-emitted untouched.

describe("manifest-core: [[dependencies]] passthrough via extras", () => {
  const raw = `[project]
name = "my-mod"
version = "1.0.0"

[[bundle]]
path = "dist/mod"

[[symlink]]
source = "dist/mod"
dest = "{SavedGames}/Mods/my-mod"

[[dependencies]]
id = "owner/some-lib"
version = "*"
optional = false

[[requires_module]]
id = "ed/f16c"
name = "F-16C Viper"
`;

  it("does not model [[dependencies]] as a first-class array", () => {
    const model = parseToml(raw);
    expect(model).not.toHaveProperty("dependencies");
    // The rest of the schema still parses normally.
    expect(model.bundle).toEqual([{ path: "dist/mod" }]);
    expect(model.symlink).toEqual([{ source: "dist/mod", dest: "{SavedGames}/Mods/my-mod" }]);
    expect(model.requires_module).toEqual([{ id: "ed/f16c", name: "F-16C Viper" }]);
  });

  it("captures the [[dependencies]] block verbatim into extras", () => {
    const model = parseToml(raw);
    expect(model.extras).toHaveLength(1);
    expect(model.extras[0]).toContain("[[dependencies]]");
    expect(model.extras[0]).toContain('id = "owner/some-lib"');
    expect(model.extras[0]).toContain('version = "*"');
    expect(model.extras[0]).toContain("optional = false");
  });

  it("survives parse -> emit -> reparse with the extras block unchanged", () => {
    const model = parseToml(raw);
    const emitted = emitToml(model);

    // The emitted TOML still carries the [[dependencies]] section verbatim.
    expect(emitted).toContain("[[dependencies]]");
    expect(emitted).toContain('id = "owner/some-lib"');

    // Re-parsing the emitted text reproduces the exact same extras — the block
    // round-trips indefinitely through the form without drifting or dropping.
    const reparsed = parseToml(emitted);
    expect(reparsed.extras).toEqual(model.extras);
    expect(reparsed.bundle).toEqual(model.bundle);
    expect(reparsed.symlink).toEqual(model.symlink);
    expect(reparsed.requires_module).toEqual(model.requires_module);
  });
});
