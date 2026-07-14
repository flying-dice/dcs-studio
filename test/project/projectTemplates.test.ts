import { describe, it, expect } from "vitest";
import {
  TEMPLATES,
  TemplateAssets,
  TemplateFile,
  slugify,
  luaIdent,
  tomlEscape,
  render,
} from "../../src/core/domain/projectTemplates";

const assets: TemplateAssets = { luaLib: new Uint8Array([0x4c, 0x01, 0x02]) };

function paths(files: TemplateFile[]): string[] {
  return files.map((f) => f.path);
}

function text(files: TemplateFile[], path: string): string {
  const file = files.find((f) => f.path === path);
  expect(file, `missing template file ${path}`).toBeDefined();
  expect(typeof file!.contents).toBe("string");
  return file!.contents as string;
}

describe("TEMPLATES metadata", () => {
  it("lists the four template tiles, ids unique, all fields filled", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(["blank", "lua-mission", "lua-hook", "rust-dll"]);
    for (const t of TEMPLATES) {
      expect(t.label).toBeTruthy();
      expect(t.description).toBeTruthy();
    }
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates runs of non-alphanumerics", () => {
    expect(slugify("My Cool Mod")).toBe("my-cool-mod");
    expect(slugify("A  B!!C")).toBe("a-b-c");
    expect(slugify("Foo_Bar.Baz")).toBe("foo-bar-baz");
  });

  it("trims and strips leading/trailing hyphen runs", () => {
    expect(slugify("  --hello--  ")).toBe("hello");
    expect(slugify("!!!wow!!!")).toBe("wow");
  });

  it("keeps digits", () => {
    expect(slugify("F-16 Viper 2")).toBe("f-16-viper-2");
    expect(slugify("123")).toBe("123");
  });

  it("falls back to untitled when nothing survives", () => {
    expect(slugify("")).toBe("untitled");
    expect(slugify("   ")).toBe("untitled");
    expect(slugify("!!!")).toBe("untitled");
    expect(slugify("---")).toBe("untitled");
  });

  it("is already-idempotent on a slug", () => {
    expect(slugify(slugify("Some Name"))).toBe(slugify("Some Name"));
  });
});

describe("luaIdent", () => {
  it("turns hyphens into underscores", () => {
    expect(luaIdent("My Cool Mod")).toBe("my_cool_mod");
  });

  it("prefixes a leading digit with mod_", () => {
    expect(luaIdent("123")).toBe("mod_123");
    expect(luaIdent("2 Fast")).toBe("mod_2_fast");
  });

  it("accepts a leading underscore", () => {
    // "_x" slugifies to "x"; craft a leading underscore via an inner hyphen.
    expect(luaIdent("a_b")).toBe("a_b");
  });

  // Every keyword class the ident must dodge (idents are lowercase, so the
  // capitalised "Self" in the source set is only reachable as "self").
  const rustStrict = [
    "as", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern", "false",
    "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub",
    "ref", "return", "self", "static", "struct", "super", "trait", "true", "type",
    "unsafe", "use", "where", "while", "async", "await",
  ];
  const rustReserved = [
    "abstract", "become", "box", "do", "final", "macro", "override", "priv", "try",
    "typeof", "unsized", "virtual", "yield", "gen",
  ];
  const lua51 = [
    "and", "elseif", "end", "function", "local", "nil", "not", "or", "repeat", "then",
    "until",
  ];

  it.each(rustStrict)("prefixes the Rust strict/2018 keyword %s", (kw) => {
    expect(luaIdent(kw)).toBe(`mod_${kw}`);
  });

  it.each(rustReserved)("prefixes the Rust reserved keyword %s", (kw) => {
    expect(luaIdent(kw)).toBe(`mod_${kw}`);
  });

  it.each(lua51)("prefixes the Lua 5.1 keyword %s", (kw) => {
    expect(luaIdent(kw)).toBe(`mod_${kw}`);
  });

  it("prefixes keywords regardless of input casing (slugify lowercases)", () => {
    expect(luaIdent("Function")).toBe("mod_function");
    expect(luaIdent("SELF")).toBe("mod_self");
  });

  it("leaves near-keywords alone", () => {
    expect(luaIdent("functional")).toBe("functional");
    expect(luaIdent("ends")).toBe("ends");
  });

  it("prefixes the empty-name fallback? no — untitled is a fine ident", () => {
    expect(luaIdent("")).toBe("untitled");
  });
});

describe("tomlEscape", () => {
  it("escapes backslashes and double quotes", () => {
    expect(tomlEscape('a"b')).toBe('a\\"b');
    expect(tomlEscape("a\\b")).toBe("a\\\\b");
  });

  it("escapes the backslash before the quote (order matters)", () => {
    expect(tomlEscape('\\"')).toBe('\\\\\\"');
  });

  it("passes plain text through", () => {
    expect(tomlEscape("plain text 123")).toBe("plain text 123");
    expect(tomlEscape("")).toBe("");
  });
});

describe("render dispatch", () => {
  it("returns undefined for an unknown template id", () => {
    expect(render("nope", "X", assets)).toBeUndefined();
    expect(render("", "X", assets)).toBeUndefined();
  });

  it("renders every advertised template", () => {
    for (const t of TEMPLATES) {
      expect(render(t.id, "Demo", assets)).toBeDefined();
    }
  });
});

describe("blank template", () => {
  const files = render("blank", "My Mod", assets)!;

  it("produces exactly the manifest", () => {
    expect(paths(files)).toEqual(["dcs-studio.toml"]);
  });

  it("renders the manifest header, project block and commented rules", () => {
    const toml = text(files, "dcs-studio.toml");
    expect(toml).toContain("# dcs-studio.toml — DCS Studio project manifest");
    expect(toml).toContain('# Generated for "My Mod".');
    expect(toml).toContain('name = "My Mod"');
    expect(toml).toContain('version = "0.1.0"');
    expect(toml).toContain('template = "blank"');
    expect(toml).toContain('dcs_min_version = "2.9.0"');
    // Install rule stays commented, slugged from the name.
    expect(toml).toContain('# dest = "{SavedGames}/Mods/my-mod"');
  });

  it("TOML-escapes quotes/backslashes in the project name value", () => {
    const toml = text(render("blank", 'He said "hi" \\ bye', assets)!, "dcs-studio.toml");
    expect(toml).toContain('name = "He said \\"hi\\" \\\\ bye"');
  });
});

describe("lua-mission template", () => {
  const files = render("lua-mission", "Red Flag 24", assets)!;

  it("produces manifest, script and README", () => {
    expect(paths(files)).toEqual(["dcs-studio.toml", "Scripts/red-flag-24.lua", "README.md"]);
  });

  it("wires the install rule to the slugged script path", () => {
    const toml = text(files, "dcs-studio.toml");
    expect(toml).toContain('template = "lua-mission"');
    expect(toml).toContain('source = "Scripts/red-flag-24.lua"');
    expect(toml).toContain('dest = "{SavedGames}/Scripts/red-flag-24.lua"');
  });

  it("uses the ident inside the script and the name in its banner", () => {
    const lua = text(files, "Scripts/red-flag-24.lua");
    expect(lua).toContain("-- Red Flag 24");
    expect(lua).toContain("local red_flag_24 = {}");
    expect(lua).toContain('red_flag_24.name    = "Red Flag 24"');
    expect(lua).toContain("function red_flag_24.start()");
    expect(lua).toContain("return red_flag_24");
  });

  it("READMEs the slug-based layout", () => {
    const md = text(files, "README.md");
    expect(md).toContain("# Red Flag 24");
    expect(md).toContain("`Scripts/red-flag-24.lua`");
    expect(md).toContain("mission script mod");
  });

  it("uses a keyword-dodging ident when the name is a keyword", () => {
    const kwFiles = render("lua-mission", "end", assets)!;
    const lua = text(kwFiles, "Scripts/end.lua");
    expect(lua).toContain("local mod_end = {}");
  });
});

describe("lua-hook template", () => {
  const files = render("lua-hook", "Server Stats", assets)!;

  it("produces manifest, hook and README with ident-based hook name", () => {
    expect(paths(files)).toEqual([
      "dcs-studio.toml",
      "Scripts/Hooks/server_stats_hook.lua",
      "README.md",
    ]);
  });

  it("installs the hook into Scripts/Hooks", () => {
    const toml = text(files, "dcs-studio.toml");
    expect(toml).toContain('template = "lua-hook"');
    expect(toml).toContain('source = "Scripts/Hooks/server_stats_hook.lua"');
    expect(toml).toContain('dest = "{SavedGames}/Scripts/Hooks"');
  });

  it("logs under the slug tag and registers callbacks", () => {
    const lua = text(files, "Scripts/Hooks/server_stats_hook.lua");
    expect(lua).toContain("local server_stats = {}");
    expect(lua).toContain('log.write("server-stats", log.INFO, msg)');
    expect(lua).toContain("function cb.onMissionLoadEnd()");
    expect(lua).toContain("DCS.setUserCallbacks(cb)");
  });

  it("READMEs the hook layout and log tag", () => {
    const md = text(files, "README.md");
    expect(md).toContain("`Scripts/Hooks/server_stats_hook.lua`");
    expect(md).toContain("`server-stats` tag");
  });
});

describe("rust-dll template", () => {
  const files = render("rust-dll", "Fast Telemetry", assets)!;

  it("produces the full cargo project file set", () => {
    expect(paths(files)).toEqual([
      "dcs-studio.toml",
      "Cargo.toml",
      ".cargo/config.toml",
      "lua5.1/lua.lib",
      "src/lib.rs",
      "Scripts/Hooks/fast_telemetry_hook.lua",
      "README.md",
    ]);
  });

  it("injects the TemplateAssets lua.lib bytes verbatim", () => {
    const lib = files.find((f) => f.path === "lua5.1/lua.lib")!;
    expect(lib.contents).toBe(assets.luaLib); // same object, not a copy
    expect(lib.contents).toBeInstanceOf(Uint8Array);
  });

  it("installs the DLL and the hook per the bridge layout", () => {
    const toml = text(files, "dcs-studio.toml");
    expect(toml).toContain('template = "rust-dll"');
    expect(toml).toContain('source = "target/release/fast_telemetry.dll"');
    expect(toml).toContain('dest = "{SavedGames}/Mods/tech/fast-telemetry/bin"');
    expect(toml).toContain('source = "Scripts/Hooks/fast_telemetry_hook.lua"');
    expect(toml).toContain('dest = "{SavedGames}/Scripts/Hooks"');
  });

  it("keeps the Cargo package/lib name in sync with the ident", () => {
    const cargo = text(files, "Cargo.toml");
    expect(cargo).toContain('name = "fast_telemetry"');
    expect(cargo).toContain('crate-type = ["cdylib"]');
    expect(cargo).toContain('mlua = { version = "0.10"');
    expect(cargo).toContain('require("fast_telemetry") looks for');
  });

  it("renders the literal require(...) snippet in every doc that quotes it", () => {
    expect(text(files, "src/lib.rs")).toContain('require("fast_telemetry") resolves inside');
    expect(text(files, "src/lib.rs")).toContain('print(require("fast_telemetry").version)');
    const md = text(files, "README.md");
    expect(md).toContain('`require("fast_telemetry")` finds `fast_telemetry.dll`');
    expect(md).toContain('but `require("fast_telemetry")` fails inside DCS');
  });

  it("pins the lua import lib via .cargo/config.toml", () => {
    const cfg = text(files, ".cargo/config.toml");
    expect(cfg).toContain('LUA_LIB_NAME = "lua"');
    expect(cfg).toContain('LUA_LIB = { value = "lua5.1", relative = true }');
  });

  it("names the lua_module fn after the ident and reads the upper-ident global", () => {
    const rs = text(files, "src/lib.rs");
    expect(rs).toContain("pub fn fast_telemetry(lua: &Lua)");
    expect(rs).toContain('lua.globals().get("FAST_TELEMETRY")');
    expect(rs).toContain("#[mlua::lua_module]");
  });

  it("hooks cpath to the slug bin dir and requires the ident", () => {
    const hook = text(files, "Scripts/Hooks/fast_telemetry_hook.lua");
    expect(hook).toContain('"Mods\\\\tech\\\\fast-telemetry\\\\bin\\\\?.dll"');
    expect(hook).toContain('FAST_TELEMETRY = { log_level = "info" }');
    expect(hook).toContain('pcall(require, "fast_telemetry")');
    expect(hook).toContain("function cb.onSimulationFrame()");
  });

  it("READMEs the build artefact and loading chain", () => {
    const md = text(files, "README.md");
    expect(md).toContain("`target/release/fast_telemetry.dll`");
    expect(md).toContain("luaopen_fast_telemetry");
    expect(md).toContain("`{SavedGames}/Mods/tech/fast-telemetry/bin`");
  });

  it("survives a digit-leading name via the mod_ ident while the slug keeps digits", () => {
    const digits = render("rust-dll", "104th", assets)!;
    expect(paths(digits)).toContain("Scripts/Hooks/mod_104th_hook.lua");
    const cargo = text(digits, "Cargo.toml");
    expect(cargo).toContain('name = "mod_104th"');
    const toml = text(digits, "dcs-studio.toml");
    expect(toml).toContain('dest = "{SavedGames}/Mods/tech/104th/bin"');
  });
});
