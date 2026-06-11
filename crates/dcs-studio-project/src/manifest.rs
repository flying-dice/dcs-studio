//! `dcs-studio.toml` parsing (model: `studio::installer`). Tolerant by
//! design: unknown sections and fields are ignored so manifests written by
//! newer tools still load.

use std::path::Path;

use serde::Deserialize;

/// The parsed project manifest.
#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub project: ProjectMeta,
    #[serde(default)]
    pub install: Vec<InstallRule>,
}

/// `[project]` metadata; only the fields the toolchain acts on.
#[derive(Debug, Deserialize)]
pub struct ProjectMeta {
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub template: String,
}

/// One `[[install]]` mapping: a project-relative `source` (file or
/// directory) copied under a root-anchored `dest` directory
/// (`{SavedGames}/...` or `{GameInstall}/...`).
#[derive(Debug, Deserialize)]
pub struct InstallRule {
    pub source: String,
    pub dest: String,
}

/// Parse manifest text.
///
/// # Errors
///
/// Invalid TOML or a missing/ill-typed required field.
pub fn parse(text: &str) -> Result<Manifest, String> {
    toml::from_str(text).map_err(|e| format!("dcs-studio.toml: {e}"))
}

/// Load and parse `<root>/dcs-studio.toml`.
///
/// # Errors
///
/// The file is missing or unreadable, or its contents fail [`parse`].
pub fn load(root: &Path) -> Result<Manifest, String> {
    let path = root.join("dcs-studio.toml");
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    parse(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rendered_manifest(template: &str, name: &str) -> String {
        let files = crate::templates::render(template, name).expect("known template");
        files
            .iter()
            .find(|f| f.path == "dcs-studio.toml")
            .expect("manifest present")
            .contents
            .as_text()
            .expect("manifest is text")
            .to_string()
    }

    #[test]
    fn parses_rendered_lua_script_manifest() {
        let manifest = parse(&rendered_manifest("lua-script", "My Script Mod"))
            .expect("rendered manifest parses");
        assert_eq!(manifest.project.name, "My Script Mod");
        assert_eq!(manifest.project.template, "lua-script");
        assert_eq!(manifest.install.len(), 1);
        assert_eq!(
            manifest.install[0].dest,
            "{SavedGames}/Scripts/my-script-mod"
        );
    }

    #[test]
    fn parses_rendered_rust_dll_manifest() {
        let manifest = parse(&rendered_manifest("rust-dll", "My Native Mod"))
            .expect("rendered manifest parses");
        assert_eq!(manifest.project.template, "rust-dll");
        assert_eq!(manifest.install.len(), 2);
        assert_eq!(
            manifest.install[0].source,
            "target/release/my_native_mod.dll"
        );
        assert_eq!(manifest.install[1].dest, "{SavedGames}/Scripts/Hooks");
    }

    #[test]
    fn unknown_fields_and_missing_install_are_tolerated() {
        let manifest =
            parse("[project]\nname = \"x\"\nfuture_field = true\n\n[shiny_new_section]\nk = 1\n")
                .expect("tolerant parse");
        assert_eq!(manifest.project.name, "x");
        assert!(manifest.install.is_empty());
    }
}
