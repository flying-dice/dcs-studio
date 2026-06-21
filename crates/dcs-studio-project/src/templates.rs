//! Project templates — the Rust home of the templates the app's New Project
//! flow and the MCP `init_project` tool scaffold (`src/lib/templates.ts` holds
//! the UI metadata; unifying the two is tracked in decisions/005).

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

/// A project's `.mcp.json` (model: `studio::cli::ScaffoldBootstrapsMcpConfig`,
/// issue #39): points an MCP editor at the IDE's hosted tool surface over
/// standard Streamable HTTP on the fixed loopback port. Unauthenticated (the
/// IDE trusts the loopback-only bind), so the config is just a URL — no secret
/// to manage. The endpoint comes from [`crate::mcp`], the one source the app's
/// server binds too, so the scaffold and the server can't drift.
fn mcp_config_file() -> TemplateFile {
    TemplateFile::text(
        ".mcp.json",
        format!(
            "{{\n\
             \x20 \"mcpServers\": {{\n\
             \x20   \"dcs-studio\": {{\n\
             \x20     \"type\": \"http\",\n\
             \x20     \"url\": \"{}\"\n\
             \x20   }}\n\
             \x20 }}\n\
             }}\n",
            crate::mcp::url(),
        ),
    )
}

/// The generated EmmyLua type definitions for the in-DCS `dcs_studio` DLL
/// surface, scaffolded so `lua-analyzer` gives completion/hover on
/// `require("dcs_studio")` (resolved in the GameGUI hooks environment). The
/// file is regenerated from the binding facade
/// (`crates/dcs-bridge/src/surface.rs`) and checked in — a types-only `@meta`
/// file, harmless wherever the runtime module isn't actually loaded.
fn studio_typedefs_file() -> TemplateFile {
    TemplateFile {
        path: "types/dcs_studio.d.lua".to_string(),
        contents: TemplateContents::Text(
            include_str!("../../dcs-bridge/types/dcs_studio.d.lua").to_string(),
        ),
    }
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
    vec![
        TemplateFile::text(
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
        ),
        mcp_config_file(),
    ]
}

fn lua_script(name: &str) -> Vec<TemplateFile> {
    let slug = slugify(name);
    let ident = lua_ident(name);
    vec![
        lua_script_manifest(name, &slug),
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
                 local function info(msg)\n\
                 \x20   -- Loaded in the DCS GUI/hooks environment, where the\n\
                 \x20   -- log API is available -- assume log + log.info.\n\
                 \x20   log.info(string.format(\"[%s] %s\", {ident}.name, msg))\n\
                 end\n\n\
                 function {ident}.start()\n\
                 \x20   info(\"loaded v\" .. {ident}.version)\n\
                 end\n\n\
                 {ident}.start()\n\n\
                 return {ident}\n"
            ),
        ),
        lua_script_readme(name, &slug),
        studio_typedefs_file(),
        mcp_config_file(),
    ]
}

fn lua_script_manifest(name: &str, slug: &str) -> TemplateFile {
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
    )
}

fn lua_script_readme(name: &str, slug: &str) -> TemplateFile {
    TemplateFile::text(
        "README.md",
        format!(
            "# {name}\n\n\
                 A DCS (Digital Combat Simulator) Lua script mod, scaffolded by DCS Studio.\n\n\
                 ## Layout\n\n\
                 - `Scripts/{slug}/main.lua` — script entry point.\n\
                 - `dcs-studio.toml` — project manifest (metadata, dependencies, install rules).\n\n\
                 ## Where scripts run\n\n\
                 Mission scripts run inside DCS's mission scripting environment: `env`,\n\
                 `timer`, `trigger`, and `world` are available; `os`, `io`, and `lfs` are\n\
                 sanitized away by default.\n\n\
                 ## MissionScripting.lua sanitization\n\n\
                 DCS strips `os`/`io`/`lfs` from mission scripts via `MissionScripting.lua`.\n\
                 DCS Studio's Mission panel can de-sanitize it to restore them — convenient\n\
                 for development, but any mission you then run can touch your filesystem.\n\
                 Re-sanitize when you are done.\n\n\
                 ## Loading options\n\n\
                 - A mission trigger: `DO SCRIPT FILE`, or `DO SCRIPT` with `dofile(...)`\n\
                 \x20 pointing at the installed script.\n\
                 - A GameGUI hook under `Scripts/Hooks` for code that runs outside missions.\n\n\
                 ## Install\n\n\
                 Install rules in `dcs-studio.toml` map project files to your DCS folders via\n\
                 named roots (`{{SavedGames}}`, `{{GameInstall}}`), resolved per-machine.\n\n\
                 ## Logs\n\n\
                 `log.info` output lands in `Saved Games/DCS/Logs/dcs.log`, tagged with the\n\
                 script name.\n"
        ),
    )
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
        studio_typedefs_file(),
        mcp_config_file(),
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
    let ident_upper = ident.to_uppercase();
    TemplateFile::text(
        "src/lib.rs",
        format!(
            "// {name} — DCS native Lua module (mlua cdylib).\n\
             //\n\
             // #[mlua::lua_module] generates the luaopen_{ident} entry point that\n\
             // Lua's require(\"{ident}\") resolves inside {ident}.dll. The function\n\
             // name below IS the module name — it must match the [lib] name.\n\
             //\n\
             // FFI rules: mlua wraps callbacks so Rust panics become Lua errors,\n\
             // but don't lean on it — no unwrap/expect in callbacks; return\n\
             // LuaResult and let errors raise in Lua, never unwind across FFI.\n\
             use mlua::prelude::*;\n\
             use std::sync::atomic::{{AtomicU64, Ordering}};\n\n\
             // Frames pumped so far. Atomic, not a Mutex: on_frame runs on DCS's\n\
             // main loop every simulation frame and must never block.\n\
             static FRAMES: AtomicU64 = AtomicU64::new(0);\n\n\
             #[mlua::lua_module]\n\
             pub fn {ident}(lua: &Lua) -> LuaResult<LuaTable> {{\n\
             \x20   // The hook sets the {ident_upper} global BEFORE require() — the same\n\
             \x20   // plain-global config pattern the DCS Studio bridge reads (DCS_BRIDGE).\n\
             \x20   let config: Option<LuaTable> = lua.globals().get(\"{ident_upper}\").ok();\n\
             \x20   let log_level: String = config\n\
             \x20       .and_then(|t| t.get(\"log_level\").ok())\n\
             \x20       .unwrap_or_else(|| \"info\".to_string());\n\
             \x20   let verbose = log_level == \"debug\";\n\n\
             \x20   let exports = lua.create_table()?;\n\
             \x20   // Prove the load from Lua: print(require(\"{ident}\").version)\n\
             \x20   exports.set(\"version\", env!(\"CARGO_PKG_VERSION\"))?;\n\
             \x20   // The effective level, so Lua can confirm what was honoured.\n\
             \x20   exports.set(\"log_level\", log_level)?;\n\n\
             \x20   // Lua-callable Rust. Returning Err raises a Lua error the caller\n\
             \x20   // can pcall — error conversion stays on mlua's side of the line.\n\
             \x20   // Verbose (log_level = \"debug\") appends the live frame count.\n\
             \x20   let greet = lua.create_function(move |_, who: String| {{\n\
             \x20       if who.is_empty() {{\n\
             \x20           return Err(LuaError::runtime(\"greet: name must not be empty\"));\n\
             \x20       }}\n\
             \x20       if verbose {{\n\
             \x20           return Ok(format!(\n\
             \x20               \"Hello, {{who}} — from Rust (frame {{}})\",\n\
             \x20               FRAMES.load(Ordering::Relaxed)\n\
             \x20           ));\n\
             \x20       }}\n\
             \x20       Ok(format!(\"Hello, {{who}} — from Rust\"))\n\
             \x20   }})?;\n\
             \x20   exports.set(\"greet\", greet)?;\n\n\
             \x20   // Pumped by the hook's onSimulationFrame; returns the frame count.\n\
             \x20   // Keep per-frame work tiny: a slow frame here is a visible stutter.\n\
             \x20   let on_frame =\n\
             \x20       lua.create_function(|_, ()| Ok(FRAMES.fetch_add(1, Ordering::Relaxed) + 1))?;\n\
             \x20   exports.set(\"on_frame\", on_frame)?;\n\n\
             \x20   Ok(exports)\n\
             }}\n"
        ),
    )
}

fn rust_dll_hook(name: &str, slug: &str, ident: &str) -> TemplateFile {
    let ident_upper = ident.to_uppercase();
    TemplateFile::text(
        format!("Scripts/Hooks/{ident}_hook.lua"),
        format!(
            "-- {name} GameGUI hook.\n\
             -- Appends the mod's bin folder to package.cpath, then loads the native\n\
             -- module (modelled on the DCS Studio bridge hook). Output lands in your\n\
             -- DCS log (Saved Games/DCS/Logs/dcs.log).\n\n\
             package.cpath = package.cpath .. \";\" .. lfs.writedir() .. \"Mods\\\\tech\\\\{slug}\\\\bin\\\\?.dll\"\n\n\
             -- Read by the Rust side on require() for configuration — the same\n\
             -- plain-global pattern the DCS Studio bridge uses (DCS_BRIDGE).\n\
             {ident_upper} = {{ log_level = \"info\" }}\n\n\
             local ok, {ident} = pcall(require, \"{ident}\")\n\
             if not ok then\n\
             \x20 log.write(\"{slug}\", log.ERROR, \"load failed: \" .. tostring({ident}))\n\
             \x20 return\n\
             end\n\
             log.write(\"{slug}\", log.INFO, \"loaded v\" .. tostring({ident}.version))\n\n\
             -- Load-time demo of a Lua-callable Rust function; errors stay in pcall.\n\
             local greeted, greeting = pcall({ident}.greet, \"{slug}\")\n\
             if greeted then\n\
             \x20 log.write(\"{slug}\", log.INFO, tostring(greeting))\n\
             else\n\
             \x20 log.write(\"{slug}\", log.ERROR, \"greet failed: \" .. tostring(greeting))\n\
             end\n\n\
             local cb = {{}}\n\
             function cb.onSimulationFrame()\n\
             \x20 -- pcall per frame: a Lua error in one frame must never break the next.\n\
             \x20 local fine, err = pcall({ident}.on_frame)\n\
             \x20 if not fine then\n\
             \x20   log.write(\"{slug}\", log.ERROR, \"on_frame: \" .. tostring(err))\n\
             \x20 end\n\
             end\n\
             DCS.setUserCallbacks(cb)\n"
        ),
    )
}

fn rust_dll_readme(name: &str, slug: &str, ident: &str) -> TemplateFile {
    TemplateFile::text(
        "README.md",
        format!(
            "# {name}\n\n\
             A DCS native Lua module (Rust cdylib via mlua), scaffolded by DCS Studio.\n\n\
             ## Prerequisites\n\n\
             - Rust via <https://rustup.rs> — no extra `rustup target` needed; the\n\
             \x20 host x86_64 Windows target builds the DLL DCS loads.\n\
             - On Windows, the MSVC toolchain (Visual Studio Build Tools with the\n\
             \x20 \"Desktop development with C++\" workload).\n\n\
             ## Build\n\n\
             ```\n\
             cargo build --release\n\
             ```\n\n\
             Produces `target/release/{ident}.dll`.\n\n\
             ## Install\n\n\
             DCS Studio's install action applies the\n\
             manifest's [[install]] rules: the DLL goes to\n\
             `{{SavedGames}}/Mods/tech/{slug}/bin`, the GameGUI hook to\n\
             `{{SavedGames}}/Scripts/Hooks`.\n\n\
             ## How loading works\n\n\
             At DCS start the hook appends the bin folder to `package.cpath`, then\n\
             `require(\"{ident}\")` finds `{ident}.dll` and calls its exported\n\
             `luaopen_{ident}` — generated by `#[mlua::lua_module]` from the `[lib]`\n\
             name. Keep the lib name, the require string, and the DLL filename in\n\
             sync, or the chain breaks at require.\n\n\
             One footgun: `.cargo/config.toml` pins `LUA_LIB` / `LUA_LIB_NAME` so the\n\
             DLL links against DCS's own `lua.dll` (import library bundled in\n\
             `lua5.1/`). Without it, cargo silently links `lua51.dll`: the build\n\
             succeeds, but `require(\"{ident}\")` fails inside DCS, which ships\n\
             `lua.dll`.\n\n\
             ## Logs\n\n\
             The hook logs under the `{slug}` tag via `log.write` into\n\
             `Saved Games/DCS/Logs/dcs.log`: a load line, the greet demo, and any\n\
             per-frame errors.\n\n\
             ## Next steps\n\n\
             - The hook already pumps `{ident}.on_frame()` every simulation frame —\n\
             \x20 grow it from there, but keep per-frame work tiny.\n\
             - Expose more Rust to Lua in `src/lib.rs` with `lua.create_function`;\n\
             \x20 return `LuaResult` so errors raise in Lua instead of unwinding\n\
             \x20 across the FFI line.\n"
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
    fn every_template_bootstraps_a_discoverable_mcp_config() {
        // model: studio::cli::ScaffoldBootstrapsMcpConfig (issue #39) — every
        // template carries a .mcp.json over HTTP on the fixed loopback port.
        // Unauthenticated: the config is just a URL, no secret to commit.
        for template in ["blank", "lua-script", "rust-dll"] {
            let files = render(template, "My Mod").expect("known template");
            let config = text_of(&files, ".mcp.json");
            // Valid JSON.
            let parsed: serde_json::Value =
                serde_json::from_str(config).expect("`.mcp.json` is valid JSON");
            let server = &parsed["mcpServers"]["dcs-studio"];
            assert_eq!(server["type"], "http", "{template}: HTTP transport");
            // Derived from the shared endpoint, not a re-typed literal, so the
            // scaffold tracks `crate::mcp` (and thus the app's server).
            assert_eq!(
                server["url"],
                serde_json::Value::String(crate::mcp::url()),
                "{template}: fixed loopback endpoint"
            );
            assert!(
                server.get("headers").is_none(),
                "{template}: unauthenticated — no Authorization header"
            );
        }
    }

    #[test]
    fn lua_script_template_scaffolds_valid_lua() {
        let files = render("lua-script", "My Script Mod").expect("known template");
        assert_eq!(files.len(), 5);
        // The dcs_studio type definitions are scaffolded for hook-side
        // completion, and must themselves parse cleanly under the engine.
        let typedefs = files
            .iter()
            .find(|f| f.path == "types/dcs_studio.d.lua")
            .expect("dcs_studio typedefs scaffolded");
        let typedef_text = typedefs.contents.as_text().expect("typedefs are text");
        assert!(typedef_text.contains("---@class dcs_studio"));
        assert!(
            dcs_lua_syntax::parser::parse(typedef_text)
                .diagnostics
                .is_empty(),
            "scaffolded dcs_studio.d.lua has syntax findings"
        );
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

        // The README teaches the mission-environment realities.
        let readme = text_of(&files, "README.md");
        assert!(readme.contains("MissionScripting"));
        assert!(readme.contains("dcs.log"));
    }

    /// Neither template scaffolds a CI workflow or a test harness: the
    /// headless test/bundle/CI tooling (the retired dcs-studio-cli) is gone,
    /// so generated projects must not reference it — `.github/` and a
    /// `tests/` spec would both strand on a toolchain that no longer ships.
    #[test]
    fn templates_ship_no_ci_workflow_or_cli_references() {
        for (template, name) in [("lua-script", "My Script Mod"), ("rust-dll", "My Native Mod")] {
            let files = render(template, name).expect("known template");
            assert!(
                !files.iter().any(|f| f.path.starts_with(".github/")),
                "{template} grew a CI workflow — the toolchain it would call is gone"
            );
            assert!(
                !files.iter().any(|f| f.path.starts_with("tests/")),
                "{template} grew a test spec — the runner it needs is gone"
            );
            for file in &files {
                if let Some(text) = file.contents.as_text() {
                    assert!(
                        !text.contains("dcs-studio-cli"),
                        "{template}: {} still references the retired dcs-studio-cli",
                        file.path
                    );
                }
            }
        }
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

        // The lib glue exposes the Lua-facing surface the hook drives.
        let lib_rs = text_of(&files, "src/lib.rs");
        assert!(lib_rs.contains("pub fn my_native_mod"));
        assert!(lib_rs.contains("\"greet\""));
        assert!(lib_rs.contains("\"on_frame\""));
        assert!(lib_rs.contains("AtomicU64"));
        // The config global is READ at require(), not just set by the hook:
        // log_level comes off the table, and verbose mode actually uses it.
        assert!(lib_rs.contains("globals().get"));
        assert!(lib_rs.contains("\"log_level\""));
        assert!(lib_rs.contains("verbose"));
        // No panic paths across the FFI line (the comment may say "unwrap",
        // the code must not call it).
        assert!(!lib_rs.contains("unwrap()"));
        assert!(!lib_rs.contains("expect("));

        // The GameGUI hook satisfies our own engine, clean.
        let hook = text_of(&files, "Scripts/Hooks/my_native_mod_hook.lua");
        let parsed = dcs_lua_syntax::parser::parse(hook);
        assert!(
            parsed.diagnostics.is_empty(),
            "hook Lua has findings: {:?}",
            parsed.diagnostics
        );
        assert!(hook.contains("require, \"my_native_mod\""));
        // The lifecycle: config global, frame pump guarded by pcall, demo call.
        // Hook and lib must reference the SAME global name, or the read above
        // silently finds nil and the hook's table is decoration.
        assert!(hook.contains("MY_NATIVE_MOD = { log_level = \"info\" }"));
        assert!(lib_rs.contains("MY_NATIVE_MOD"));
        let frame_cb = between(hook, "function cb.onSimulationFrame()", "\nend");
        assert!(frame_cb.contains("pcall(my_native_mod.on_frame)"));
        assert!(hook.contains("DCS.setUserCallbacks(cb)"));
        assert!(hook.contains("pcall(my_native_mod.greet"));

        // The README walks the whole bootstrap path.
        let readme = text_of(&files, "README.md");
        assert!(readme.contains("luaopen_my_native_mod"));
        assert!(readme.contains("dcs.log"));
        assert!(readme.contains("rustup"));
        assert!(readme.contains("cargo build --release"));

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
