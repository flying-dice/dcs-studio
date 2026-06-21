//! `CargoLua.toml` parsing (model `studio::cargolua`). Tolerant by design —
//! unknown sections and fields are ignored, mirroring `dcs-studio.toml` — but
//! dependency selectors enforce Cargo's rule: a `github = "owner/repo"` is
//! required and at most one of `branch`/`tag`/`rev` may pin it.
//!
//! ```toml
//! [package]
//! name = "all-my-mods"
//! version = "0.1.0"
//!
//! [dependencies]
//! moose = { github = "FlightControl-Master/MOOSE", tag = "10.0.0" }
//! mylib = { github = "flying-dice/mylib", branch = "main" }
//! util  = { github = "flying-dice/util", rev = "abc1234" }
//!
//! [[bundle]]
//! name = "all-my-mods.lua"
//! path = "src/main.lua"
//! ```

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;

use crate::CargoError;

/// The file a project's lua-cargo config lives in.
pub const MANIFEST_FILE: &str = "CargoLua.toml";

/// The parsed `CargoLua.toml`. Tolerant: unknown keys are ignored so manifests
/// written by newer tools still load.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CargoManifest {
    /// `[package]` metadata.
    pub package: PackageMeta,
    /// `[dependencies]`, keyed by the local dependency name (a `BTreeMap` so
    /// iteration — and thus the lockfile — is name-sorted and deterministic).
    pub dependencies: BTreeMap<String, Dependency>,
    /// `[[bundle]]` targets.
    pub bundle: Vec<BundleTarget>,
}

/// `[package]` — the fields the toolchain acts on.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PackageMeta {
    pub name: String,
    #[serde(default)]
    pub version: String,
}

/// One `[[bundle]]` target: the amalgamation output `name` grown from `path`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct BundleTarget {
    pub name: String,
    pub path: String,
}

/// The git ref a dependency pins to. Cargo's rule: at most one of
/// branch/tag/rev; none given means the remote's default branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Selector {
    Branch(String),
    Tag(String),
    Rev(String),
    DefaultBranch,
}

impl Selector {
    /// The git refname to check out. The default branch has no concrete name
    /// here; resolution refreshes `origin/HEAD` instead — see
    /// [`crate::resolve`].
    #[must_use]
    pub fn refname(&self) -> Option<&str> {
        match self {
            Self::Branch(s) | Self::Tag(s) | Self::Rev(s) => Some(s),
            Self::DefaultBranch => None,
        }
    }
}

/// One normalized dependency: a GitHub `owner/repo` plus its ref selector.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dependency {
    pub owner: String,
    pub repo: String,
    pub selector: Selector,
}

impl Dependency {
    /// The `https://` clone URL for this dependency's `owner/repo`.
    #[must_use]
    pub fn clone_url(&self) -> String {
        format!("https://github.com/{}/{}.git", self.owner, self.repo)
    }

    /// The `owner/repo` slug recorded in the lockfile.
    #[must_use]
    pub fn github(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
}

/// The raw serde shape before normalization: every field optional so we can
/// report precise errors (missing `github`, multiple selectors) rather than a
/// generic serde failure.
#[derive(Debug, Deserialize)]
struct RawManifest {
    package: PackageMeta,
    #[serde(default)]
    dependencies: BTreeMap<String, RawDependency>,
    #[serde(default)]
    bundle: Vec<BundleTarget>,
}

#[derive(Debug, Deserialize)]
struct RawDependency {
    github: Option<String>,
    branch: Option<String>,
    tag: Option<String>,
    rev: Option<String>,
}

/// Split and validate an `owner/repo` slug: exactly one `/`, both halves
/// non-empty.
fn split_owner_repo(slug: &str) -> Result<(String, String), CargoError> {
    let mut parts = slug.split('/');
    let owner = parts.next().unwrap_or_default();
    let repo = parts.next().unwrap_or_default();
    let bad = |c: &str| {
        c.is_empty()
            || c.starts_with('-') // can't be read as a git option once in the clone url
            || c.chars().any(|ch| ch.is_whitespace() || ch.is_control())
    };
    if bad(owner) || bad(repo) || parts.next().is_some() {
        return Err(CargoError::Manifest(format!(
            "dependency github must be `owner/repo` (no leading '-', spaces, or extra '/'), got {slug:?}"
        )));
    }
    Ok((owner.to_string(), repo.to_string()))
}

impl RawDependency {
    /// Normalize into a [`Dependency`], enforcing Cargo's rule: `github`
    /// required, at most one of branch/tag/rev.
    fn normalize(self, name: &str) -> Result<Dependency, CargoError> {
        let github = self.github.ok_or_else(|| {
            CargoError::Manifest(format!("dependency {name:?} is missing `github = \"owner/repo\"`"))
        })?;
        let (owner, repo) = split_owner_repo(&github)?;

        let selectors = [
            self.branch.map(Selector::Branch),
            self.tag.map(Selector::Tag),
            self.rev.map(Selector::Rev),
        ];
        let mut chosen: Option<Selector> = None;
        for selector in selectors.into_iter().flatten() {
            if chosen.is_some() {
                return Err(CargoError::Manifest(format!(
                    "dependency {name:?} sets more than one of branch/tag/rev"
                )));
            }
            chosen = Some(selector);
        }

        Ok(Dependency {
            owner,
            repo,
            selector: chosen.unwrap_or(Selector::DefaultBranch),
        })
    }
}

/// Parse `CargoLua.toml` text.
///
/// # Errors
///
/// Invalid TOML, a missing required field, a malformed `owner/repo`, or a
/// dependency that sets more than one of branch/tag/rev — all
/// [`CargoError::Manifest`].
pub fn parse(text: &str) -> Result<CargoManifest, CargoError> {
    let raw: RawManifest =
        toml::from_str(text).map_err(|e| CargoError::Manifest(format!("{MANIFEST_FILE}: {e}")))?;

    let mut dependencies = BTreeMap::new();
    for (name, raw_dep) in raw.dependencies {
        let dep = raw_dep.normalize(&name)?;
        dependencies.insert(name, dep);
    }

    Ok(CargoManifest {
        package: raw.package,
        dependencies,
        bundle: raw.bundle,
    })
}

/// Read and parse `<root>/CargoLua.toml`.
///
/// # Errors
///
/// The file is missing or unreadable, or its contents fail [`parse`].
pub fn find_and_parse(root: &Path) -> Result<CargoManifest, CargoError> {
    let path = root.join(MANIFEST_FILE);
    let text = std::fs::read_to_string(&path)
        .map_err(|e| CargoError::Manifest(format!("reading {}: {e}", path.display())))?;
    parse(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: &str = r#"
[package]
name = "all-my-mods"
version = "0.1.0"

[dependencies]
moose = { github = "FlightControl-Master/MOOSE", tag = "10.0.0" }
mylib = { github = "flying-dice/mylib", branch = "main" }
util  = { github = "flying-dice/util", rev = "abc1234" }
plain = { github = "flying-dice/plain" }

[[bundle]]
name = "all-my-mods.lua"
path = "src/main.lua"

[[bundle]]
name = "second.lua"
path = "src/second.lua"
"#;

    #[test]
    fn parses_table_form_dependencies_and_bundles() {
        let m = parse(FULL).expect("parse");
        assert_eq!(m.package.name, "all-my-mods");
        assert_eq!(m.package.version, "0.1.0");
        assert_eq!(m.dependencies.len(), 4);

        let moose = &m.dependencies["moose"];
        assert_eq!(moose.owner, "FlightControl-Master");
        assert_eq!(moose.repo, "MOOSE");
        assert_eq!(moose.selector, Selector::Tag("10.0.0".into()));
        assert_eq!(
            moose.clone_url(),
            "https://github.com/FlightControl-Master/MOOSE.git"
        );

        assert_eq!(
            m.dependencies["mylib"].selector,
            Selector::Branch("main".into())
        );
        assert_eq!(
            m.dependencies["util"].selector,
            Selector::Rev("abc1234".into())
        );
    }

    #[test]
    fn multiple_bundle_targets_parse() {
        let m = parse(FULL).expect("parse");
        assert_eq!(m.bundle.len(), 2);
        assert_eq!(m.bundle[0].name, "all-my-mods.lua");
        assert_eq!(m.bundle[0].path, "src/main.lua");
        assert_eq!(m.bundle[1].name, "second.lua");
    }

    #[test]
    fn default_branch_when_no_selector() {
        let m = parse(FULL).expect("parse");
        assert_eq!(m.dependencies["plain"].selector, Selector::DefaultBranch);
    }

    #[test]
    fn unknown_keys_are_ignored() {
        let m = parse(
            r#"
[package]
name = "x"
shiny = true

[dependencies]
d = { github = "a/b", future_knob = 1 }

[[bundle]]
name = "x.lua"
path = "m.lua"
extra = "ok"
"#,
        )
        .expect("tolerant parse");
        assert_eq!(m.package.name, "x");
        assert_eq!(m.dependencies["d"].selector, Selector::DefaultBranch);
    }

    #[test]
    fn two_selectors_is_an_error() {
        let err = parse(
            r#"
[package]
name = "x"
[dependencies]
d = { github = "a/b", tag = "1.0", branch = "main" }
"#,
        )
        .unwrap_err();
        match err {
            CargoError::Manifest(m) => assert!(m.contains("more than one"), "{m}"),
            other => panic!("expected Manifest, got {other:?}"),
        }
    }

    #[test]
    fn missing_github_is_an_error() {
        let err = parse(
            r#"
[package]
name = "x"
[dependencies]
d = { branch = "main" }
"#,
        )
        .unwrap_err();
        assert!(matches!(err, CargoError::Manifest(_)));
    }

    #[test]
    fn malformed_owner_repo_is_an_error() {
        // Includes leading-`-` and whitespace components (option-injection into
        // the clone url) alongside the structural cases.
        for bad in ["justrepo", "a/b/c", "/b", "a/", "", "-x/repo", "a/-b", "a /b", "a/b c"] {
            let text = format!("[package]\nname = \"x\"\n[dependencies]\nd = {{ github = \"{bad}\" }}\n");
            let err = parse(&text).unwrap_err();
            assert!(
                matches!(err, CargoError::Manifest(_)),
                "{bad:?} should reject"
            );
        }
    }
}
