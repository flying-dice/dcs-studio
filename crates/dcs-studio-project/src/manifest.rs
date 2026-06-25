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
    /// `[[dependencies]]` — other Marketplace mods this one requires, resolved +
    /// installed transitively by the Marketplace (model `studio::market`,
    /// issue #10). An absent section means no dependencies. (A required STOCK
    /// DCS module is a different prerequisite — issue #65 — not expressed here.)
    #[serde(default)]
    pub dependencies: Vec<DependencyRule>,
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
    /// `[release]` — release-payload packaging (issue #62): the per-volume size
    /// a large `.7z` payload is split on. An absent section means the default.
    #[serde(default)]
    pub release: ReleaseConfig,
}

/// Default per-volume size when `[release] volume_size` is absent (1.5 GiB). A
/// payload at or under this ships as a single `.7z`; a larger one is split into
/// `.7z.001`, `.7z.002`, … (issue #62).
pub const DEFAULT_VOLUME_SIZE: &str = "1.5 GiB";

/// The smallest a volume may be: a tiny `volume_size` would explode the volume
/// count, so the parser raises anything below this 1 MiB floor.
pub const MIN_VOLUME_SIZE_BYTES: u64 = 1024 * 1024;

/// GitHub rejects a release asset larger than 2 GiB. Each volume is clamped to
/// 2 GiB minus a 128 MiB safety margin (~1.875 GiB) so a volume is never
/// produced that GitHub would reject (issue #62).
pub const MAX_VOLUME_SIZE_BYTES: u64 = 2 * 1024 * 1024 * 1024 - 128 * 1024 * 1024;

/// `[release]` — release-payload packaging (issue #62). `volume_size` is the
/// per-volume split size; authored as a byte count (`1610612736`) or a number
/// with a unit (`"1.5 GiB"`, `"1500 MB"`, `"512MiB"`). Binary units (`KiB`,
/// `MiB`, `GiB`) are powers of 1024; decimal units (`KB`, `MB`, `GB`) powers of
/// 1000. Read through [`ReleaseConfig::volume_size_bytes`], which parses and
/// clamps to the GitHub-safe range.
#[derive(Debug, Deserialize)]
#[serde(default)]
pub struct ReleaseConfig {
    volume_size: RawVolumeSize,
}

impl Default for ReleaseConfig {
    fn default() -> Self {
        Self {
            volume_size: RawVolumeSize::Text(DEFAULT_VOLUME_SIZE.to_string()),
        }
    }
}

/// `volume_size` as authored: a bare TOML integer (bytes) or a string with an
/// optional unit. Both are normalised to bytes by [`ReleaseConfig::volume_size_bytes`].
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawVolumeSize {
    Bytes(u64),
    Text(String),
}

/// A parsed, clamped per-volume size (see [`ReleaseConfig::volume_size_bytes`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClampedVolumeSize {
    /// The byte count each volume except the last is filled to.
    pub bytes: u64,
    /// `Some` when the authored size was clamped (e.g. above the GitHub-safe
    /// ceiling) — surfaced to the author at publish time, never silent.
    pub warning: Option<String>,
}

impl ReleaseConfig {
    /// The per-volume split size in bytes: the authored `volume_size` parsed and
    /// clamped to `[MIN_VOLUME_SIZE_BYTES, MAX_VOLUME_SIZE_BYTES]`. `warning` is
    /// `Some` when the authored value was clamped.
    ///
    /// # Errors
    ///
    /// The authored `volume_size` string is not a valid size (a number with an
    /// optional `B`/`KB`/`MB`/`GB`/`KiB`/`MiB`/`GiB` unit).
    pub fn volume_size_bytes(&self) -> Result<ClampedVolumeSize, String> {
        let parsed = match &self.volume_size {
            RawVolumeSize::Bytes(n) => *n,
            RawVolumeSize::Text(s) => parse_volume_size(s)?,
        };
        let (bytes, warning) = clamp_volume_size(parsed);
        Ok(ClampedVolumeSize { bytes, warning })
    }
}

/// Parse a `<number><unit>` volume size to bytes — decimals in fixed-point `u128`
/// so there is no float cast or precision loss. Binary units are 1024-based,
/// decimal units 1000-based; a bare number is bytes.
fn parse_volume_size(spec: &str) -> Result<u64, String> {
    let s = spec.trim();
    if s.is_empty() {
        return Err("volume_size is empty".to_string());
    }
    let split = s
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(s.len());
    let (num, unit) = s.split_at(split);
    let multiplier: u64 = match unit.trim().to_ascii_lowercase().as_str() {
        "" | "b" => 1,
        "k" | "kib" => 1024,
        "m" | "mib" => 1024 * 1024,
        "g" | "gib" => 1024 * 1024 * 1024,
        "kb" => 1_000,
        "mb" => 1_000_000,
        "gb" => 1_000_000_000,
        other => return Err(format!("volume_size has an unknown unit '{other}'")),
    };
    let mult = u128::from(multiplier);
    let (whole_str, frac_str) = num.split_once('.').unwrap_or((num, ""));
    let whole: u128 = if whole_str.is_empty() {
        0
    } else {
        whole_str
            .parse()
            .map_err(|_| format!("volume_size is not a number: '{spec}'"))?
    };
    let mut total = whole
        .checked_mul(mult)
        .ok_or_else(|| format!("volume_size is too large: '{spec}'"))?;
    if !frac_str.is_empty() {
        if !frac_str.bytes().all(|b| b.is_ascii_digit()) {
            return Err(format!("volume_size is not a number: '{spec}'"));
        }
        let frac: u128 = frac_str
            .parse()
            .map_err(|_| format!("volume_size is not a number: '{spec}'"))?;
        let scale = 10u128
            .checked_pow(frac_str.len() as u32)
            .ok_or_else(|| format!("volume_size has too many decimals: '{spec}'"))?;
        let frac_bytes = mult
            .checked_mul(frac)
            .ok_or_else(|| format!("volume_size is too large: '{spec}'"))?
            / scale;
        total = total
            .checked_add(frac_bytes)
            .ok_or_else(|| format!("volume_size is too large: '{spec}'"))?;
    }
    u64::try_from(total).map_err(|_| format!("volume_size is too large: '{spec}'"))
}

/// Clamp a parsed size to `[MIN, MAX]`, returning a warning when it was clamped.
fn clamp_volume_size(bytes: u64) -> (u64, Option<String>) {
    if bytes > MAX_VOLUME_SIZE_BYTES {
        (
            MAX_VOLUME_SIZE_BYTES,
            Some(format!(
                "volume_size {bytes} B exceeds the GitHub-safe ceiling; clamped to {MAX_VOLUME_SIZE_BYTES} B"
            )),
        )
    } else if bytes < MIN_VOLUME_SIZE_BYTES {
        (
            MIN_VOLUME_SIZE_BYTES,
            Some(format!(
                "volume_size {bytes} B is below the {MIN_VOLUME_SIZE_BYTES} B floor; raised to it"
            )),
        )
    } else {
        (bytes, None)
    }
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

/// One `[[dependencies]]` entry (model `studio::market::Dependency`): another
/// Marketplace mod this one needs. `id` is the dependency's `owner/name` — the
/// same id the Marketplace ledger keys on. `version` is a semver constraint
/// matched against the dependency's latest release tag (`*` or empty = any; a
/// mismatch warns, never fails). An `optional` dependency that can't be resolved
/// is skipped with a warning instead of failing the install.
#[derive(Debug, Clone, Deserialize)]
pub struct DependencyRule {
    pub id: String,
    /// Display name for the dependency; falls back to `id` when omitted.
    #[serde(default)]
    pub name: String,
    /// Semver constraint against the dependency's latest release tag; empty or
    /// `*` means any version.
    #[serde(default)]
    pub version: String,
    /// An optional dependency is skipped (with a warning) when unresolvable,
    /// rather than failing the install.
    #[serde(default)]
    pub optional: bool,
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
        // An absent `[[dependencies]]` section means no dependencies.
        assert!(manifest.dependencies.is_empty());
    }

    #[test]
    fn dependencies_parse_with_tolerant_defaults() {
        let manifest = parse(
            "[project]\nname = \"x\"\n\n\
             [[dependencies]]\nid = \"flying-dice/base-mod\"\nname = \"Base Mod\"\nversion = \"^1.2\"\noptional = false\n\n\
             [[dependencies]]\nid = \"octocat/extras\"\n",
        )
        .expect("dependencies parse");
        assert_eq!(manifest.dependencies.len(), 2);
        assert_eq!(manifest.dependencies[0].id, "flying-dice/base-mod");
        assert_eq!(manifest.dependencies[0].name, "Base Mod");
        assert_eq!(manifest.dependencies[0].version, "^1.2");
        assert!(!manifest.dependencies[0].optional);
        // The second entry omits everything but `id` — defaults fill the rest.
        assert_eq!(manifest.dependencies[1].id, "octocat/extras");
        assert_eq!(manifest.dependencies[1].name, "");
        assert_eq!(manifest.dependencies[1].version, "");
        assert!(!manifest.dependencies[1].optional);
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
    fn absent_release_section_means_default_volume_size() {
        let manifest = parse("[project]\nname = \"x\"\n").expect("parse");
        let sized = manifest.release.volume_size_bytes().expect("default parses");
        // Default 1.5 GiB, in range → no clamp warning.
        assert_eq!(sized.bytes, 1_610_612_736);
        assert_eq!(sized.warning, None);
    }

    #[test]
    fn volume_size_parses_binary_decimal_and_fractional_units() {
        let cases = [
            ("512 MiB", 536_870_912),
            ("1.5 GiB", 1_610_612_736),
            ("0.5GiB", 536_870_912),
            ("1500MB", 1_500_000_000),
            ("1048576", 1_048_576), // bare integer = bytes
        ];
        for (spec, want) in cases {
            let manifest = parse(&format!(
                "[project]\nname = \"x\"\n\n[release]\nvolume_size = \"{spec}\"\n"
            ))
            .expect("parse");
            let sized = manifest.release.volume_size_bytes().expect("valid size");
            assert_eq!(sized.bytes, want, "spec {spec}");
            assert_eq!(sized.warning, None, "spec {spec} should be in range");
        }
    }

    #[test]
    fn volume_size_accepts_a_bare_toml_integer() {
        let manifest =
            parse("[project]\nname = \"x\"\n\n[release]\nvolume_size = 536870912\n").expect("parse");
        let sized = manifest.release.volume_size_bytes().expect("valid size");
        assert_eq!(sized.bytes, 536_870_912);
        assert_eq!(sized.warning, None);
    }

    #[test]
    fn volume_size_above_the_ceiling_is_clamped_with_a_warning() {
        let manifest =
            parse("[project]\nname = \"x\"\n\n[release]\nvolume_size = \"4 GiB\"\n").expect("parse");
        let sized = manifest.release.volume_size_bytes().expect("valid size");
        assert_eq!(sized.bytes, MAX_VOLUME_SIZE_BYTES);
        assert!(sized.warning.is_some(), "clamping down must warn");
    }

    #[test]
    fn volume_size_below_the_floor_is_raised_with_a_warning() {
        let manifest =
            parse("[project]\nname = \"x\"\n\n[release]\nvolume_size = \"100 KiB\"\n").expect("parse");
        let sized = manifest.release.volume_size_bytes().expect("valid size");
        assert_eq!(sized.bytes, MIN_VOLUME_SIZE_BYTES);
        assert!(sized.warning.is_some(), "raising to the floor must warn");
    }

    #[test]
    fn an_unparseable_volume_size_is_an_error_naming_the_value() {
        for spec in ["banana", "5 PB", "1.2.3 GiB", ""] {
            let manifest = parse(&format!(
                "[project]\nname = \"x\"\n\n[release]\nvolume_size = \"{spec}\"\n"
            ))
            .expect("manifest itself parses");
            assert!(
                manifest.release.volume_size_bytes().is_err(),
                "spec {spec:?} should be rejected"
            );
        }
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
