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
    /// `[format]` — Lua formatter options (SPEC.md §7); an absent section
    /// (or field) formats with house-style defaults.
    #[serde(default)]
    pub format: dcs_lua_fmt::FormatConfig,
    /// `[test]` — Lua test discovery (issue #9); an absent section means
    /// the defaults (`tests/**/*.test.lua`).
    #[serde(default)]
    pub test: TestConfig,
    /// `[build]` — Lua bundling (issue #9). Optional: bundling without a
    /// declared entry is an error, never a guess.
    #[serde(default)]
    pub build: BuildConfig,
}

/// `[test]` — where `dcs-studio-cli test` discovers spec files.
#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct TestConfig {
    /// Project-relative directory walked for specs.
    pub dir: String,
    /// Filename suffix a spec must carry.
    pub suffix: String,
}

impl Default for TestConfig {
    fn default() -> Self {
        Self {
            dir: "tests".to_string(),
            suffix: ".test.lua".to_string(),
        }
    }
}

/// `[build]` — what `dcs-studio-cli bundle` amalgamates.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct BuildConfig {
    /// Project-relative entry script the require graph grows from.
    pub entry: Option<String>,
    /// Bundle filename under `dist/`; defaults to `<project slug>.lua`.
    pub output: Option<String>,
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

    #[test]
    fn absent_test_and_build_sections_mean_defaults() {
        let manifest = parse("[project]\nname = \"x\"\n").expect("parse");
        assert_eq!(manifest.test.dir, "tests");
        assert_eq!(manifest.test.suffix, ".test.lua");
        assert_eq!(manifest.build.entry, None);
        assert_eq!(manifest.build.output, None);
    }

    #[test]
    fn test_and_build_sections_parse_per_field() {
        let manifest = parse(
            "[project]\nname = \"x\"\n\n[test]\ndir = \"specs\"\n\n[build]\nentry = \"main.lua\"\noutput = \"bundle.lua\"\n",
        )
        .expect("parse");
        assert_eq!(manifest.test.dir, "specs");
        // Untouched field keeps its default.
        assert_eq!(manifest.test.suffix, ".test.lua");
        assert_eq!(manifest.build.entry.as_deref(), Some("main.lua"));
        assert_eq!(manifest.build.output.as_deref(), Some("bundle.lua"));
    }

    #[test]
    fn absent_format_section_means_house_defaults() {
        let manifest = parse("[project]\nname = \"x\"\n").expect("parse");
        assert_eq!(manifest.format, dcs_lua_fmt::FormatConfig::default());
    }

    #[test]
    fn format_section_overrides_per_field() {
        let manifest = parse(
            "[project]\nname = \"x\"\n\n[format]\nindent_width = 2\nquote_style = \"single\"\nfuture_knob = true\n",
        )
        .expect("parse");
        assert_eq!(manifest.format.indent_width, 2);
        assert_eq!(manifest.format.quote_style, dcs_lua_fmt::QuoteStyle::Single);
        // Untouched fields keep their defaults; unknown keys are tolerated.
        assert_eq!(manifest.format.max_width, 100);
        assert_eq!(
            manifest.format.trailing_comma,
            dcs_lua_fmt::TrailingComma::Multiline
        );
    }
}
