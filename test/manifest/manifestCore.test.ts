import { describe, it, expect } from "vitest";
import DcsManifestCore from "../../media/manifest-core.js";

const { parseToml, emitToml } = DcsManifestCore;

// dcs-studio no longer models [[dependencies]] (that section belongs to the
// separate Lua-manager toolchain now) but manifest-core's job is to never drop
// what it doesn't model: an unmodeled `[[...]]` block is captured verbatim into
// `model.extras` and re-emitted untouched. This proves an existing manifest
// authored against the old schema — with a `[[dependencies]]` section — keeps
// that section intact through the authoring form's parse -> emit cycle.

describe("manifest-core: [[dependencies]] passthrough via extras", () => {
  const raw = `[project]
name = "my-mod"
version = "1.0.0"

[[install]]
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
    expect(model.install).toEqual([{ source: "dist/mod", dest: "{SavedGames}/Mods/my-mod" }]);
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
    expect(reparsed.install).toEqual(model.install);
    expect(reparsed.requires_module).toEqual(model.requires_module);
  });
});
