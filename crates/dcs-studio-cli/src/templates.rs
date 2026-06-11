//! Project templates (model: `studio::cli::Cli.RenderTemplate`) — the
//! Rust home of the same templates the app's New Project flow offers
//! (`src/lib/templates.ts`; unifying the two is tracked in decisions/005).

/// One file to materialise, relative to the new project root.
pub struct TemplateFile {
    pub path: String,
    pub contents: String,
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

/// Valid Lua identifier derived from the project name.
fn lua_ident(name: &str) -> String {
    let ident = slugify(name).replace('-', "_");
    if ident.starts_with(|c: char| c.is_ascii_lowercase() || c == '_') {
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
        _ => None,
    }
}

fn blank(name: &str) -> Vec<TemplateFile> {
    let slug = slugify(name);
    vec![TemplateFile {
        path: "dcs-studio.toml".to_string(),
        contents: format!(
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
    }]
}

fn lua_script(name: &str) -> Vec<TemplateFile> {
    let slug = slugify(name);
    let ident = lua_ident(name);
    vec![
        TemplateFile {
            path: "dcs-studio.toml".to_string(),
            contents: format!(
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
        },
        TemplateFile {
            path: format!("Scripts/{slug}/main.lua"),
            contents: format!(
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
        },
        TemplateFile {
            path: "README.md".to_string(),
            contents: format!(
                "# {name}\n\n\
                 A DCS (Digital Combat Simulator) Lua script mod, scaffolded by DCS Studio.\n\n\
                 ## Layout\n\n\
                 - `Scripts/{slug}/main.lua` — script entry point.\n\
                 - `dcs-studio.toml` — project manifest (metadata, dependencies, install rules).\n\n\
                 ## Install\n\n\
                 Install rules in `dcs-studio.toml` map project files to your DCS folders via\n\
                 named roots (`{{SavedGames}}`, `{{GameInstall}}`), resolved per-machine.\n"
            ),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lua_script_template_scaffolds_valid_lua() {
        let files = render("lua-script", "My Script Mod").expect("known template");
        assert_eq!(files.len(), 3);
        let main = files
            .iter()
            .find(|f| f.path.ends_with("main.lua"))
            .expect("entry point present");
        // The scaffold must satisfy our own engine.
        let parsed = dcs_lua_syntax::parser::parse(&main.contents);
        assert!(
            parsed.diagnostics.is_empty(),
            "template Lua has findings: {:?}",
            parsed.diagnostics
        );
        assert!(main.path.contains("my-script-mod"));
        assert!(main.contents.contains("my_script_mod"));
    }

    #[test]
    fn unknown_template_is_none_and_slugs_never_collapse_to_empty() {
        assert!(render("nope", "x").is_none());
        assert_eq!(slugify("!!!"), "untitled");
        assert_eq!(slugify("My Mod 2"), "my-mod-2");
    }
}
