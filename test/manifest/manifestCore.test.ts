import { describe, it, expect } from "vitest";
import DcsManifestCore from "../../media/manifest-core.js";

const { parseToml, emitToml } = DcsManifestCore;

// manifest-core splits packaging ([[bundle]]) from linking ([[symlink]]) and
// normalizes legacy [[install]] into the two on parse. These tests pin the
// normalization matrix (install-only, mixed, new-only), the emit-only-new-blocks
// migration path, and the never-drop-what-we-don't-model extras passthrough.

describe("manifest-core: [[install]] normalization", () => {
  it("install-only: each rule becomes one bundle path + one symlink", () => {
    const model = parseToml(`[project]
name = "my-mod"

[[install]]
source = "Scripts/a.lua"
dest = "{SavedGames}/Scripts/a.lua"

[[install]]
source = "Mods/tech/x"
dest = "{SavedGames}/Mods/tech/x"
`);
    // No `install` field is ever exposed downstream.
    expect(model).not.toHaveProperty("install");
    expect(model.bundle).toEqual([{ path: "Scripts/a.lua" }, { path: "Mods/tech/x" }]);
    expect(model.symlink).toEqual([
      { source: "Scripts/a.lua", dest: "{SavedGames}/Scripts/a.lua" },
      { source: "Mods/tech/x", dest: "{SavedGames}/Mods/tech/x" },
    ]);
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

  it("mixed: explicit blocks come first, install-derived entries are appended", () => {
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
    expect(model.bundle).toEqual([{ path: "Mods/tech/f16-weapons" }, { path: "Scripts/legacy.lua" }]);
    expect(model.symlink).toEqual([
      { source: "Mods/tech/f16-weapons/entry.lua", dest: "{SavedGames}/Mods/tech/f16-weapons/entry.lua" },
      { source: "Scripts/legacy.lua", dest: "{SavedGames}/Scripts/legacy.lua" },
    ]);
  });

  it("dedupes identical entries when install duplicates an explicit block", () => {
    const model = parseToml(`[project]
name = "my-mod"

[[bundle]]
path = "Scripts/a.lua"

[[symlink]]
source = "Scripts/a.lua"
dest = "{SavedGames}/Scripts/a.lua"

[[install]]
source = "Scripts/a.lua"
dest = "{SavedGames}/Scripts/a.lua"
`);
    // The install rule is identical to the explicit blocks → not duplicated.
    expect(model.bundle).toEqual([{ path: "Scripts/a.lua" }]);
    expect(model.symlink).toEqual([{ source: "Scripts/a.lua", dest: "{SavedGames}/Scripts/a.lua" }]);
  });

  it("emits only bundle/symlink — never [[install]] (the migration path)", () => {
    const model = parseToml(`[project]
name = "my-mod"

[[install]]
source = "Scripts/a.lua"
dest = "{SavedGames}/Scripts/a.lua"
`);
    const emitted = emitToml(model);
    expect(emitted).not.toContain("[[install]]");
    expect(emitted).toContain("[[bundle]]");
    expect(emitted).toContain('path = "Scripts/a.lua"');
    expect(emitted).toContain("[[symlink]]");
    expect(emitted).toContain('source = "Scripts/a.lua"');
    expect(emitted).toContain('dest = "{SavedGames}/Scripts/a.lua"');
    // Re-parsing the emitted (now install-free) text is a stable fixed point.
    const reparsed = parseToml(emitted);
    expect(reparsed.bundle).toEqual(model.bundle);
    expect(reparsed.symlink).toEqual(model.symlink);
  });

  it("an empty manifest yields empty bundle/symlink arrays", () => {
    const model = parseToml("");
    expect(model.bundle).toEqual([]);
    expect(model.symlink).toEqual([]);
    expect(model.requires_module).toEqual([]);
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
