//! Project templates (model: `studio::cli::Cli.RenderTemplate`) — the
//! Rust home of the same templates the app's New Project flow offers
//! (`src/lib/templates.ts`; unifying the two is tracked in decisions/005).

/// Contents of one template file: UTF-8 text or verbatim bytes.
pub enum TemplateContents {
    Text(String),
    Binary(&'static [u8]),
}

impl TemplateContents {
    /// The text of a `Text` file, or `None` for a binary.
    #[must_use]
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text),
            Self::Binary(_) => None,
        }
    }

    /// Raw bytes, whatever the variant — what lands on disk.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        match self {
            Self::Text(text) => text.as_bytes(),
            Self::Binary(bytes) => bytes,
        }
    }
}

/// One file to materialise, relative to the new project root.
pub struct TemplateFile {
    pub path: String,
    pub contents: TemplateContents,
}

impl TemplateFile {
    fn text(path: impl Into<String>, contents: String) -> Self {
        Self {
            path: path.into(),
            contents: TemplateContents::Text(contents),
        }
    }
}

/// Folder-safe slug: lowercase, runs of non-alphanumerics become hyphens.
#[must_use]
pub fn slugify(name: &str) -> String {
    let slug: String = name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let collapsed = slug
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if collapsed.is_empty() {
        "untitled".to_string()
    } else {
        collapsed
    }
}

/// Rust keywords, strict and reserved (the rendered templates use the ident
/// as a Cargo package/lib name and a `pub fn` name). Lua keywords come from
/// the engine's own lexer (`dcs_lua_syntax::TokenKind::keyword`).
const RUST_KEYWORDS: &[&str] = &[
    "as", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern", "false", "fn",
    "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref",
    "return", "self", "Self", "static", "struct", "super", "trait", "true", "type", "unsafe",
    "use", "where", "while", "async", "await", "abstract", "become", "box", "do", "final", "macro",
    "override", "priv", "try", "typeof", "unsized", "virtual", "yield", "gen",
];

/// Whether `ident` is reserved in Rust or Lua and so cannot appear as a bare
/// identifier in the rendered sources.
fn is_keyword(ident: &str) -> bool {
    RUST_KEYWORDS.contains(&ident) || dcs_lua_syntax::TokenKind::keyword(ident).is_some()
}

/// Valid Rust *and* Lua identifier derived from the project name; keywords
/// in either language get the same `mod_` prefix as bad leading characters.
fn lua_ident(name: &str) -> String {
    let ident = slugify(name).replace('-', "_");
    if ident.starts_with(|c: char| c.is_ascii_lowercase() || c == '_') && !is_keyword(&ident) {
        ident
    } else {
        format!("mod_{ident}")
    }
}

/// Escape a value for a TOML basic (double-quoted) string.
fn toml_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn manifest_header(name: &str) -> String {
    format!(
        "# dcs-studio.toml — DCS Studio project manifest\n\
         # Generated for \"{name}\". Describes the mod, its files, where each installs\n\
         # to, and what it depends on. Install destinations use named roots, resolved\n\
         # per-machine at install time:\n\
         #   {{SavedGames}}  → your DCS \"Saved Games\" folder\n\
         #   {{GameInstall}} → your DCS game install directory\n"
    )
}

fn project_block(name: &str, template: &str) -> String {
    format!(
        "\n[project]\nname = \"{}\"\nversion = \"0.1.0\"\nauthor = \"\"\ndescription = \"\"\ntemplate = \"{template}\"\ndcs_min_version = \"2.9.0\"\n",
        toml_escape(name)
    )
}

/// Render a template's files, or `None` for an unknown id.
#[must_use]
pub fn render(template: &str, name: &str) -> Option<Vec<TemplateFile>> {
    match template {
        "blank" => Some(blank(name)),
        "lua-script" => Some(lua_script(name)),
        "rust-dll" => Some(rust_dll(name)),
        _ => None,
    }
}

fn blank(name: &str) -> Vec<TemplateFile> {
    let slug = slugify(name);
    vec![TemplateFile::text(
        "dcs-studio.toml",
        format!(
            "{}{}\n\
             # Required modules / other mods. Uncomment and edit as needed.\n\
             # [[dependencies]]\n\
             # id = \"F-16C_50\"\n\
             # name = \"F-16C Viper\"\n\
             # version = \"*\"\n\
             # optional = false\n\n\
             # Install rules: copy matching sources to a destination under a named root.\n\
             # [[install]]\n\
             # source = \".\"\n\
             # dest = \"{{SavedGames}}/Mods/{slug}\"\n\n\
             # File manifest — tracked project files and their role.\n\
             # [[files]]\n\
             # path = \"main.lua\"\n\
             # role = \"script\"\n",
            manifest_header(name),
            project_block(name, "blank")
        ),
    )]
}

fn lua_script(name: &str) -> Vec<TemplateFile> {
    let slug = slugify(name);
    let ident = lua_ident(name);
    vec![
        TemplateFile::text(
            "dcs-studio.toml",
            format!(
                "{}{}\n\
                 # Required modules / other mods.\n\
                 [[dependencies]]\n\
                 id = \"F-16C_50\"\n\
                 name = \"F-16C Viper\"\n\
                 version = \"*\"\n\
                 optional = false\n\n\
                 # Install rules: copy matching sources to a destination under a named root.\n\
                 [[install]]\n\
                 source = \"Scripts/{slug}/\"\n\
                 dest = \"{{SavedGames}}/Scripts/{slug}\"\n\n\
                 # File manifest — tracked project files and their role.\n\
                 [[files]]\n\
                 path = \"Scripts/{slug}/main.lua\"\n\
                 role = \"script\"\n\n\
                 [[files]]\n\
                 path = \"README.md\"\n\
                 role = \"doc\"\n",
                manifest_header(name),
                project_block(name, "lua-script")
            ),
        ),
        TemplateFile::text(
            format!("Scripts/{slug}/main.lua"),
            format!(
                "-- {name}\n\
                 -- DCS Studio — Lua Script Mod\n\
                 --\n\
                 -- Entry point loaded by DCS. Keep logic small and log liberally; output lands\n\
                 -- in your DCS log (Saved Games/DCS/Logs/dcs.log).\n\n\
                 local {ident} = {{}}\n\n\
                 {ident}.name    = \"{name}\"\n\
                 {ident}.version = \"0.1.0\"\n\n\
                 local function log(msg)\n\
                 \x20   -- env.info exists inside the mission scripting environment.\n\
                 \x20   if env and env.info then\n\
                 \x20       env.info(string.format(\"[%s] %s\", {ident}.name, msg))\n\
                 \x20   else\n\
                 \x20       print(string.format(\"[%s] %s\", {ident}.name, msg))\n\
                 \x20   end\n\
                 end\n\n\
                 function {ident}.start()\n\
                 \x20   log(\"loaded v\" .. {ident}.version)\n\
                 end\n\n\
                 {ident}.start()\n\n\
                 return {ident}\n"
            ),
        ),
        TemplateFile::text(
            "README.md",
            format!(
                "# {name}\n\n\
                 A DCS (Digital Combat Simulator) Lua script mod, scaffolded by DCS Studio.\n\n\
                 ## Layout\n\n\
                 - `Scripts/{slug}/main.lua` — script entry point.\n\
                 - `dcs-studio.toml` — project manifest (metadata, dependencies, install rules).\n\n\
                 ## Install\n\n\
                 Install rules in `dcs-studio.toml` map project files to your DCS folders via\n\
                 named roots (`{{SavedGames}}`, `{{GameInstall}}`), resolved per-machine.\n"
            ),
        ),
    ]
}

/// A standalone mlua cdylib mod, generalising `crates/dcs-bridge`: the Lua
/// module name equals the crate lib name (`require("<ident>")` loads
/// `<ident>.dll` and calls `luaopen_<ident>`).
fn rust_dll(name: &str) -> Vec<TemplateFile> {
    let slug = slugify(name);
    let ident = lua_ident(name);
    vec![
        rust_dll_manifest(name, &slug, &ident),
        rust_dll_cargo_toml(&ident),
        TemplateFile::text(
            ".cargo/config.toml",
            "# Link against the import library for DCS's own lua.dll (lua5.1/lua.lib).\n\
             # Without this, mlua's lua51 feature links lua51.dll — the build still\n\
             # succeeds, but require() fails silently inside DCS, which ships lua.dll.\n\
             [env]\n\
             LUA_LIB_NAME = \"lua\"\n\
             LUA_LIB = { value = \"lua5.1\", relative = true }\n"
                .to_string(),
        ),
        TemplateFile {
            path: "lua5.1/lua.lib".to_string(),
            contents: TemplateContents::Binary(include_bytes!("../../dcs-bridge/lua5.1/lua.lib")),
        },
        rust_dll_lib_rs(name, &ident),
        rust_dll_hook(name, &slug, &ident),
        rust_dll_readme(name, &slug, &ident),
    ]
}

fn rust_dll_manifest(name: &str, slug: &str, ident: &str) -> TemplateFile {
    TemplateFile::text(
        "dcs-studio.toml",
        format!(
            "{}{}\n\
             # Install rules: the built DLL lands under Mods/tech, the GameGUI hook\n\
             # under Scripts/Hooks — the same layout the DCS Studio bridge uses.\n\
             [[install]]\n\
             source = \"target/release/{ident}.dll\"\n\
             dest = \"{{SavedGames}}/Mods/tech/{slug}/bin\"\n\n\
             [[install]]\n\
             source = \"Scripts/Hooks/{ident}_hook.lua\"\n\
             dest = \"{{SavedGames}}/Scripts/Hooks\"\n\n\
             # File manifest — tracked project files and their role.\n\
             [[files]]\n\
             path = \"src/lib.rs\"\n\
             role = \"script\"\n\n\
             [[files]]\n\
             path = \"README.md\"\n\
             role = \"doc\"\n",
            manifest_header(name),
            project_block(name, "rust-dll")
        ),
    )
}

fn rust_dll_cargo_toml(ident: &str) -> TemplateFile {
    TemplateFile::text(
        "Cargo.toml",
        format!(
            "# The package name reuses the lib ident: a slug like \"123\" is not a\n\
             # valid Cargo package name (leading digit), but the ident always is.\n\
             [package]\n\
             name = \"{ident}\"\n\
             version = \"0.1.0\"\n\
             edition = \"2021\"\n\n\
             # The lib name is the Lua module name: require(\"{ident}\") looks for\n\
             # {ident}.dll exporting luaopen_{ident} — keep it in sync with the hook.\n\
             [lib]\n\
             name = \"{ident}\"\n\
             crate-type = [\"cdylib\"]\n\n\
             [dependencies]\n\
             mlua = {{ version = \"0.10\", features = [\"lua51\", \"module\", \"serialize\", \"macros\"] }}\n\n\
             # Do NOT set panic = \"abort\" for release: mlua converts Rust unwinds\n\
             # into Lua errors; aborting would take DCS down with the mod.\n"
        ),
    )
}

fn rust_dll_lib_rs(name: &str, ident: &str) -> TemplateFile {
    TemplateFile::text(
        "src/lib.rs",
        format!(
            "// {name} — DCS native Lua module (mlua cdylib).\n\
             //\n\
             // #[mlua::lua_module] generates the luaopen_{ident} entry point that\n\
             // Lua's require(\"{ident}\") resolves inside {ident}.dll. The function\n\
             // name below IS the module name — it must match the [lib] name.\n\
             use mlua::prelude::*;\n\n\
             #[mlua::lua_module]\n\
             pub fn {ident}(lua: &Lua) -> LuaResult<LuaTable> {{\n\
             \x20   let exports = lua.create_table()?;\n\
             \x20   // Prove the load from Lua: print(require(\"{ident}\").version)\n\
             \x20   exports.set(\"version\", env!(\"CARGO_PKG_VERSION\"))?;\n\
             \x20   Ok(exports)\n\
             }}\n"
        ),
    )
}

fn rust_dll_hook(name: &str, slug: &str, ident: &str) -> TemplateFile {
    TemplateFile::text(
        format!("Scripts/Hooks/{ident}_hook.lua"),
        format!(
            "-- {name} GameGUI hook.\n\
             -- Appends the mod's bin folder to package.cpath, then loads the native\n\
             -- module (modelled on the DCS Studio bridge hook). Output lands in your\n\
             -- DCS log (Saved Games/DCS/Logs/dcs.log).\n\n\
             package.cpath = package.cpath .. \";\" .. lfs.writedir() .. \"Mods\\\\tech\\\\{slug}\\\\bin\\\\?.dll\"\n\n\
             local ok, mod = pcall(require, \"{ident}\")\n\
             if ok then\n\
             \x20 log.write(\"{slug}\", log.INFO, \"loaded v\" .. tostring(mod.version))\n\
             else\n\
             \x20 log.write(\"{slug}\", log.ERROR, \"load failed: \" .. tostring(mod))\n\
             end\n"
        ),
    )
}

fn rust_dll_readme(name: &str, slug: &str, ident: &str) -> TemplateFile {
    TemplateFile::text(
        "README.md",
        format!(
            "# {name}\n\n\
             A DCS native Lua module (Rust cdylib via mlua), scaffolded by DCS Studio.\n\n\
             ## Build\n\n\
             ```\n\
             cargo build --release\n\
             ```\n\n\
             Produces `target/release/{ident}.dll`.\n\n\
             ## Deploy\n\n\
             Install rules in `dcs-studio.toml` copy the DLL to\n\
             `{{SavedGames}}/Mods/tech/{slug}/bin` and the GameGUI hook to\n\
             `{{SavedGames}}/Scripts/Hooks`. Apply them with DCS Studio's install\n\
             action or `dcs-studio-cli install`.\n\n\
             ## The LUA_LIB footgun\n\n\
             `.cargo/config.toml` pins `LUA_LIB` / `LUA_LIB_NAME` so the DLL links\n\
             against DCS's own `lua.dll` (import library bundled in `lua5.1/`).\n\
             Without it, cargo silently links `lua51.dll`: the build succeeds, but\n\
             `require(\"{ident}\")` fails inside DCS, which ships `lua.dll`.\n\n\
             ## Logs\n\n\
             The hook logs under the `{slug}` tag in your DCS log:\n\
             `Saved Games/DCS/Logs/dcs.log`.\n"
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_of<'a>(files: &'a [TemplateFile], path: &str) -> &'a str {
        files
            .iter()
            .find(|f| f.path == path)
            .unwrap_or_else(|| panic!("{path} present"))
            .contents
            .as_text()
            .expect("text file")
    }

    #[test]
    fn lua_script_template_scaffolds_valid_lua() {
        let files = render("lua-script", "My Script Mod").expect("known template");
        assert_eq!(files.len(), 3);
        let main = files
            .iter()
            .find(|f| f.path.ends_with("main.lua"))
            .expect("entry point present");
        let contents = main.contents.as_text().expect("lua is text");
        // The scaffold must satisfy our own engine.
        let parsed = dcs_lua_syntax::parser::parse(contents);
        assert!(
            parsed.diagnostics.is_empty(),
            "template Lua has findings: {:?}",
            parsed.diagnostics
        );
        assert!(main.path.contains("my-script-mod"));
        assert!(contents.contains("my_script_mod"));
    }

    #[test]
    fn unknown_template_is_none_and_slugs_never_collapse_to_empty() {
        assert!(render("nope", "x").is_none());
        assert_eq!(slugify("!!!"), "untitled");
        assert_eq!(slugify("My Mod 2"), "my-mod-2");
    }

    #[test]
    fn rust_dll_template_renders_buildable_ingredients() {
        let files = render("rust-dll", "My Native Mod").expect("known template");

        // The Cargo manifest parses, and the lib name IS the Lua module name.
        let cargo: toml::Value =
            toml::from_str(text_of(&files, "Cargo.toml")).expect("Cargo.toml parses as TOML");
        assert_eq!(cargo["lib"]["name"].as_str(), Some("my_native_mod"));
        // The package name reuses the ident: slugs may start with a digit,
        // which Cargo rejects as a package name.
        assert_eq!(cargo["package"]["name"].as_str(), Some("my_native_mod"));

        // The GameGUI hook satisfies our own engine, clean.
        let hook = text_of(&files, "Scripts/Hooks/my_native_mod_hook.lua");
        let parsed = dcs_lua_syntax::parser::parse(hook);
        assert!(
            parsed.diagnostics.is_empty(),
            "hook Lua has findings: {:?}",
            parsed.diagnostics
        );
        assert!(hook.contains("require, \"my_native_mod\""));

        // The bundled import library is a genuine COFF archive.
        let lib = files
            .iter()
            .find(|f| f.path == "lua5.1/lua.lib")
            .expect("lua.lib present");
        let bytes = lib.contents.as_bytes();
        assert!(!bytes.is_empty(), "lua.lib must not be empty");
        assert!(
            bytes.starts_with(b"!<arch>"),
            "lua.lib must start with the COFF archive magic"
        );
    }

    /// Slice of `text` between `prefix` and `suffix`, or panic.
    fn between<'a>(text: &'a str, prefix: &str, suffix: &str) -> &'a str {
        let start = text
            .find(prefix)
            .unwrap_or_else(|| panic!("{prefix:?} present"))
            + prefix.len();
        let end = text[start..]
            .find(suffix)
            .unwrap_or_else(|| panic!("{suffix:?} after {prefix:?}"));
        &text[start..start + end]
    }

    #[test]
    fn keyword_names_are_prefixed_in_every_rendered_artifact() {
        // "loop" and "type" are Rust keywords, "local" a Lua one: bare, they
        // render an uncompilable `pub fn loop` / `[lib] name = "loop"` or a
        // broken hook. All must take the mod_ prefix, everywhere.
        for (name, ident) in [
            ("loop", "mod_loop"),
            ("type", "mod_type"),
            ("local", "mod_local"),
        ] {
            let files = render("rust-dll", name).expect("known template");
            let cargo: toml::Value =
                toml::from_str(text_of(&files, "Cargo.toml")).expect("Cargo.toml parses as TOML");
            assert_eq!(cargo["package"]["name"].as_str(), Some(ident));
            assert_eq!(cargo["lib"]["name"].as_str(), Some(ident));
            let lib_rs = text_of(&files, "src/lib.rs");
            assert!(lib_rs.contains(&format!("pub fn {ident}")), "fn for {name}");
            let manifest = text_of(&files, "dcs-studio.toml");
            assert!(manifest.contains(&format!("target/release/{ident}.dll")));
            let hook = text_of(&files, &format!("Scripts/Hooks/{ident}_hook.lua"));
            assert!(hook.contains(&format!("require, \"{ident}\"")));
        }
        // Sanity on the reviewer's exact repro.
        let files = render("rust-dll", "loop").expect("known template");
        assert!(text_of(&files, "src/lib.rs").contains("pub fn mod_loop"));
    }

    #[test]
    fn rust_dll_template_survives_a_numeric_name() {
        // "123" slugifies to "123", which Cargo rejects as a package name
        // (leading digit) — both names must use the lua_ident instead.
        let files = render("rust-dll", "123").expect("known template");

        let cargo: toml::Value =
            toml::from_str(text_of(&files, "Cargo.toml")).expect("Cargo.toml parses as TOML");
        assert_eq!(cargo["package"]["name"].as_str(), Some("mod_123"));
        assert_eq!(cargo["lib"]["name"].as_str(), Some("mod_123"));

        // The manifest installs the DLL the build actually produces, and the
        // hook requires the module the DLL actually exports.
        let manifest = text_of(&files, "dcs-studio.toml");
        assert!(manifest.contains("target/release/mod_123.dll"));
        let hook = text_of(&files, "Scripts/Hooks/mod_123_hook.lua");
        assert!(hook.contains("require, \"mod_123\""));

        // The hook's cpath and the [[install]] dest must agree on the slug,
        // or the hook searches a folder nothing installs into.
        // In the Lua source the backslashes are themselves escaped.
        let cpath_slug = between(hook, r"Mods\\tech\\", r"\\bin");
        let dest_slug = between(manifest, "{SavedGames}/Mods/tech/", "/bin");
        assert_eq!(cpath_slug, dest_slug);
        assert_eq!(cpath_slug, "123");
    }
}
