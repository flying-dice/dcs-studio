//! `dcs-studio.toml` parsing (model: `studio::installer`). Tolerant by
//! design: unknown sections and fields are ignored so manifests written by
//! newer tools still load.

use std::path::{Path, PathBuf};

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
    /// `[lints]` — per-lint levels, the Cargo `[lints]` idiom. Absent section
    /// means every lint keeps its built-in default.
    #[serde(default)]
    pub lints: LintsConfig,
}

/// `[lints]` — lint levels by language, mirroring Cargo's `[lints.rust]` /
/// `[lints.clippy]`. `[lints.lua]` maps a Lua lint name to a level
/// (`allow`/`warn`/`deny`/`forbid`).
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct LintsConfig {
    /// `[lints.lua]` — `<lint-name> = "<level>"` (e.g.
    /// `operator-type-mismatch = "allow"`).
    pub lua: std::collections::HashMap<String, String>,
}

/// `[test]` — spec discovery config (directory + filename suffix).
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

/// `[build]` — single-file bundle config (require-graph entry + output name).
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
    let path = root.join(crate::MANIFEST_FILE);
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    parse(&text)
}

/// The directory of the nearest `dcs-studio.toml` governing `path`: walk up
/// from `path` itself when it is a directory, or its parent when it is a file,
/// returning the first ancestor that holds a manifest. `None` when none does.
#[must_use]
pub fn nearest(path: &Path) -> Option<PathBuf> {
    let start = if path.is_dir() {
        path
    } else {
        path.parent().unwrap_or(path)
    };
    start
        .ancestors()
        .find(|dir| dir.join(crate::MANIFEST_FILE).is_file())
        .map(Path::to_path_buf)
}

/// The `[format]` config governing `path`: the `[format]` table of the
/// [`nearest`] manifest, house defaults when no manifest is found or the
/// nearest one cannot be read or parsed. Silent — a malformed manifest must
/// not wedge formatting; the editor and `dcs-studio fmt` resolve config the
/// same way so a buffer formatted in the editor matches what CI checks.
#[must_use]
pub fn format_config_for(path: &Path) -> dcs_lua_fmt::FormatConfig {
    nearest(path)
        .and_then(|dir| load(&dir).ok())
        .map(|manifest| manifest.format)
        .unwrap_or_default()
}

/// The project's `[lints.lua]` levels (`name -> "level"`), or empty when the
/// manifest is absent or invalid. The one place the "no manifest → defaults"
/// rule lives, so every edge (LSP server, CLI, MCP) honours `[lints.lua]`
/// identically.
#[must_use]
pub fn lua_lint_levels(root: &Path) -> std::collections::HashMap<String, String> {
    load(root)
        .map(|manifest| manifest.lints.lua)
        .unwrap_or_default()
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
    fn absent_lints_section_means_no_levels() {
        let manifest = parse("[project]\nname = \"x\"\n").expect("parse");
        assert!(manifest.lints.lua.is_empty());
    }

    #[test]
    fn lints_lua_table_maps_names_to_levels() {
        let manifest = parse(
            "[project]\nname = \"x\"\n\n[lints.lua]\noperator-type-mismatch = \"allow\"\nparam-usage-mismatch = \"deny\"\n",
        )
        .expect("parse");
        assert_eq!(
            manifest
                .lints
                .lua
                .get("operator-type-mismatch")
                .map(String::as_str),
            Some("allow")
        );
        assert_eq!(
            manifest
                .lints
                .lua
                .get("param-usage-mismatch")
                .map(String::as_str),
            Some("deny")
        );
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

    /// A throwaway directory tree under the system temp dir; removed on drop so
    /// a panicking assertion never leaks a fixture.
    struct TempTree(PathBuf);

    impl TempTree {
        fn new(tag: &str) -> Self {
            let root =
                std::env::temp_dir().join(format!("dcs-fmtcfg-test-{tag}-{}", std::process::id()));
            std::fs::create_dir_all(&root).expect("create temp root");
            TempTree(root)
        }
        fn write(&self, rel: &str, contents: &str) {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).expect("create parent");
            std::fs::write(path, contents).expect("write file");
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn format_config_defaults_when_no_manifest() {
        let tree = TempTree::new("nomanifest");
        tree.write("src/m.lua", "x = 1\n");
        assert_eq!(
            format_config_for(&tree.0.join("src/m.lua")),
            dcs_lua_fmt::FormatConfig::default()
        );
    }

    #[test]
    fn format_config_reads_nearest_manifest_walking_up() {
        let tree = TempTree::new("walkup");
        tree.write(
            "dcs-studio.toml",
            "[project]\nname = \"x\"\n\n[format]\nindent_width = 2\n",
        );
        // A file nested two levels below the manifest still resolves it.
        tree.write("a/b/deep.lua", "x = 1\n");
        let config = format_config_for(&tree.0.join("a/b/deep.lua"));
        assert_eq!(config.indent_width, 2);
        // Untouched fields keep their house defaults.
        assert_eq!(config.max_width, 100);
    }

    #[test]
    fn format_config_defaults_when_manifest_is_malformed() {
        let tree = TempTree::new("malformed");
        // Present but unparseable manifest must fall back to defaults, never
        // wedge formatting.
        tree.write("dcs-studio.toml", "this is = not [valid toml");
        tree.write("m.lua", "x = 1\n");
        assert_eq!(
            format_config_for(&tree.0.join("m.lua")),
            dcs_lua_fmt::FormatConfig::default()
        );
    }
}
