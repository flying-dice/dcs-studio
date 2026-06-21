//! The require-graph bundler/amalgamator (model `studio::cargolua::Bundler`).
//! From each `[[bundle]]` entry, walk the `require("mod")` graph
//! ([`crate::requires`]), resolve each module name to a file under the search
//! roots, and emit ONE self-contained Lua 5.1 file behind a `__require` shim.
//!
//! Sources are copied **verbatim** — no AST rewrite — with `local require =
//! __require` injected as the first line of each module wrapper so an inner
//! `require` hits the bundle's own shim. Requires that resolve to neither a
//! local module nor a vendored dep (DCS built-ins / host-provided) become
//! warnings, never failures: the shim falls back to a host `require` at runtime.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use crate::manifest::{self, BundleTarget};
use crate::requires::scan_requires;
use crate::{CargoError, resolve};

/// The outcome of a bundle: the emitted file, the module names amalgamated
/// (sorted), and the requires that resolved to nothing (warnings).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleReport {
    pub output: PathBuf,
    pub modules: Vec<String>,
    pub warnings: Vec<String>,
}

/// Bundle every `[[bundle]]` target of the project at `root`.
///
/// Returns the report of the LAST target (the common case is a single bundle);
/// every target is still emitted. An empty `[[bundle]]` list yields an empty
/// report.
///
/// # Errors
///
/// A missing/malformed manifest ([`CargoError::Manifest`]) or an entry path
/// that does not exist ([`CargoError::MissingEntry`]).
pub fn bundle(root: &Path) -> Result<BundleReport, CargoError> {
    let manifest = manifest::find_and_parse(root)?;
    let vendored = resolve::vendored_roots(root).unwrap_or_default();

    let mut last = BundleReport {
        output: root.join("dist"),
        modules: Vec::new(),
        warnings: Vec::new(),
    };
    for target in &manifest.bundle {
        last = bundle_one(root, target, &vendored)?;
    }
    Ok(last)
}

/// Bundle a single `[[bundle]]` target.
fn bundle_one(
    root: &Path,
    target: &BundleTarget,
    vendored: &BTreeMap<String, PathBuf>,
) -> Result<BundleReport, CargoError> {
    let entry_path = root.join(&target.path);
    if !entry_path.is_file() {
        return Err(CargoError::MissingEntry(target.path.clone()));
    }

    let search = SearchRoots::new(root, &entry_path, vendored);
    let entry_module = module_name_of_entry(&target.path);

    // Walk the require graph, keyed by canonical module name.
    let mut modules: BTreeMap<String, String> = BTreeMap::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut stack: Vec<(String, PathBuf)> = vec![(entry_module.clone(), entry_path.clone())];

    while let Some((name, path)) = stack.pop() {
        if modules.contains_key(&name) {
            continue; // cycle / diamond guard
        }
        let src = std::fs::read_to_string(&path)
            .map_err(|e| CargoError::Io(format!("reading {}: {e}", path.display())))?;
        for req in scan_requires(&src) {
            if modules.contains_key(&req) || stack.iter().any(|(n, _)| n == &req) {
                continue;
            }
            match search.resolve(&req) {
                Some(found) => stack.push((req, found)),
                None => {
                    if !warnings.iter().any(|w| w == &req) {
                        warnings.push(req);
                    }
                }
            }
        }
        modules.insert(name, src);
    }

    let output_path = root.join("dist").join(&target.name);
    let emitted = emit_bundle(&modules, &entry_module);
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| CargoError::Io(format!("creating dist dir: {e}")))?;
    }
    std::fs::write(&output_path, emitted)
        .map_err(|e| CargoError::Io(format!("writing bundle: {e}")))?;

    warnings.sort();
    Ok(BundleReport {
        output: output_path,
        modules: modules.into_keys().collect(),
        warnings,
    })
}

/// The directories a module name is resolved against, in priority order.
struct SearchRoots {
    roots: Vec<PathBuf>,
}

impl SearchRoots {
    fn new(root: &Path, entry_path: &Path, vendored: &BTreeMap<String, PathBuf>) -> Self {
        let mut roots = Vec::new();
        if let Some(dir) = entry_path.parent() {
            roots.push(dir.to_path_buf());
        }
        roots.push(root.to_path_buf());
        roots.push(root.join("src"));
        // The vendor parent, so a dep named `moose` resolves as the bare module
        // `moose` to `.lua-cargo/deps/moose/init.lua` (the dep's package root).
        if let Some(dep_root) = vendored.values().next() {
            if let Some(parent) = dep_root.parent() {
                roots.push(parent.to_path_buf());
            }
        }
        for dep_root in vendored.values() {
            roots.push(dep_root.clone());
            roots.push(dep_root.join("src"));
            roots.push(dep_root.join("lua"));
        }
        // De-dup while preserving order.
        let mut seen = Vec::new();
        roots.retain(|r| {
            if seen.contains(r) {
                false
            } else {
                seen.push(r.clone());
                true
            }
        });
        Self { roots }
    }

    /// Resolve a module name `a.b` to `a/b.lua` or `a/b/init.lua` under the
    /// first search root that holds it.
    fn resolve(&self, module: &str) -> Option<PathBuf> {
        let rel = module.replace('.', "/");
        for base in &self.roots {
            let flat = base.join(format!("{rel}.lua"));
            if flat.is_file() {
                return Some(flat);
            }
            let init = base.join(&rel).join("init.lua");
            if init.is_file() {
                return Some(init);
            }
        }
        None
    }
}

/// Derive the entry module name from its project-relative path: drop a `.lua`
/// suffix and turn separators into dots (`src/main.lua` → `src.main`,
/// `foo/init.lua` → `foo`).
fn module_name_of_entry(rel: &str) -> String {
    let norm = rel.replace('\\', "/");
    let stem = norm.strip_suffix(".lua").unwrap_or(&norm);
    let stem = stem.strip_suffix("/init").unwrap_or(stem);
    stem.trim_start_matches("./").replace('/', ".")
}

/// Emit the self-contained bundle. `modules` is name → verbatim source; the
/// tail returns the entry module.
fn emit_bundle(modules: &BTreeMap<String, String>, entry: &str) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "-- Generated by lua-cargo. Self-contained amalgamation; do not edit."
    );
    out.push_str("local __modules = {}\n");
    out.push_str("local __loaded = {}\n");
    out.push_str("local function __require(name)\n");
    out.push_str("  if __loaded[name] ~= nil then return __loaded[name] end\n");
    out.push_str("  local factory = __modules[name]\n");
    out.push_str("  if factory then\n");
    out.push_str("    local result = factory()\n");
    out.push_str("    if result == nil then result = true end\n");
    out.push_str("    __loaded[name] = result\n");
    out.push_str("    return result\n");
    out.push_str("  end\n");
    out.push_str("  if _G.require then return _G.require(name) end\n");
    out.push_str("  error(\"module '\" .. name .. \"' not found in bundle\")\n");
    out.push_str("end\n\n");

    // Module factories, name-sorted (BTreeMap) for deterministic output.
    for (name, src) in modules {
        let _ = writeln!(out, "__modules[{}] = function()", lua_quote(name));
        out.push_str("local require = __require\n");
        out.push_str(src.trim_end_matches(['\n', '\r']));
        out.push('\n');
        out.push_str("end\n\n");
    }

    let _ = writeln!(out, "return __require({})", lua_quote(entry));
    out
}

/// A Lua double-quoted string literal of `s` (module names are bare, but quote
/// defensively).
fn lua_quote(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Command;

    struct TempTree(PathBuf);

    impl TempTree {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "lua-cargo-bundle-{tag}-{}-{}",
                std::process::id(),
                nanos()
            ));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).expect("root");
            TempTree(root)
        }
        fn write(&self, rel: &str, contents: &str) {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).expect("parent");
            std::fs::write(path, contents).expect("write");
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn nanos() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    }

    fn project_with_local_and_vendored() -> TempTree {
        let tree = TempTree::new("p");
        tree.write(
            "CargoLua.toml",
            "[package]\nname = \"p\"\n[dependencies]\nmoose = { github = \"a/moose\" }\n\n[[bundle]]\nname = \"out.lua\"\npath = \"src/main.lua\"\n",
        );
        // Entry requires a local module `util` and a vendored dep module `moose`.
        tree.write(
            "src/main.lua",
            "local util = require(\"util\")\nlocal moose = require(\"moose\")\nreturn util.go() + moose.x\n",
        );
        tree.write("src/util.lua", "local M = {}\nfunction M.go() return 1 end\nreturn M\n");
        // Stub a vendored dep directly on disk (no git): .lua-cargo/deps/moose.
        tree.write(
            ".lua-cargo/deps/moose/init.lua",
            "local M = { x = 2 }\nreturn M\n",
        );
        // A directory existence marker so vendored_roots() sees the checkout.
        tree.write(".lua-cargo/deps/moose/.keep", "");
        tree
    }

    #[test]
    fn bundles_one_file_with_shim_and_tail() {
        let tree = project_with_local_and_vendored();
        let report = bundle(&tree.0).expect("bundle");

        let out = tree.0.join("dist").join("out.lua");
        assert!(out.is_file(), "one dist file produced");
        assert_eq!(report.output, out);

        let text = std::fs::read_to_string(&out).unwrap();
        assert!(text.contains("local function __require(name)"), "shim present");
        assert!(text.contains("return __require(\"src.main\")"), "entry tail: {text}");
        assert!(text.contains("__modules[\"util\"]"), "local module wrapped");
        assert!(text.contains("__modules[\"moose\"]"), "vendored module wrapped");
        // No unresolved requires here.
        assert!(report.warnings.is_empty(), "warnings: {:?}", report.warnings);
        // util, moose, src.main.
        assert!(report.modules.contains(&"util".to_string()));
        assert!(report.modules.contains(&"moose".to_string()));
    }

    #[test]
    fn rerun_is_deterministic() {
        let tree = project_with_local_and_vendored();
        bundle(&tree.0).expect("bundle 1");
        let first = std::fs::read(tree.0.join("dist").join("out.lua")).unwrap();
        bundle(&tree.0).expect("bundle 2");
        let second = std::fs::read(tree.0.join("dist").join("out.lua")).unwrap();
        assert_eq!(first, second, "byte-for-byte deterministic");
    }

    #[test]
    fn unresolved_require_is_a_warning_not_an_error() {
        let tree = TempTree::new("warn");
        tree.write(
            "CargoLua.toml",
            "[package]\nname = \"p\"\n[[bundle]]\nname = \"out.lua\"\npath = \"src/main.lua\"\n",
        );
        tree.write(
            "src/main.lua",
            "local net = require(\"socket\")\nreturn net\n",
        );
        let report = bundle(&tree.0).expect("bundle still succeeds");
        assert_eq!(report.warnings, vec!["socket".to_string()]);
    }

    #[test]
    fn missing_entry_is_an_error() {
        let tree = TempTree::new("missing");
        tree.write(
            "CargoLua.toml",
            "[package]\nname = \"p\"\n[[bundle]]\nname = \"out.lua\"\npath = \"src/nope.lua\"\n",
        );
        let err = bundle(&tree.0).unwrap_err();
        assert!(matches!(err, CargoError::MissingEntry(_)), "{err:?}");
    }

    #[test]
    fn cycle_does_not_loop_forever() {
        let tree = TempTree::new("cycle");
        tree.write(
            "CargoLua.toml",
            "[package]\nname = \"p\"\n[[bundle]]\nname = \"out.lua\"\npath = \"src/main.lua\"\n",
        );
        tree.write("src/main.lua", "require(\"a\")\nreturn 1\n");
        tree.write("src/a.lua", "require(\"b\")\nreturn 1\n");
        tree.write("src/b.lua", "require(\"a\")\nreturn 1\n");
        let report = bundle(&tree.0).expect("bundle");
        assert!(report.modules.contains(&"a".to_string()));
        assert!(report.modules.contains(&"b".to_string()));
    }

    /// Oracle: if `luac5.1` is on PATH, the emitted bundle must parse.
    #[test]
    fn emitted_bundle_parses_with_luac_if_available() {
        if Command::new("luac5.1").arg("-v").output().is_err() {
            return; // gate on availability
        }
        let tree = project_with_local_and_vendored();
        bundle(&tree.0).expect("bundle");
        let out = tree.0.join("dist").join("out.lua");
        let status = Command::new("luac5.1")
            .arg("-p")
            .arg(&out)
            .status()
            .expect("run luac5.1");
        assert!(status.success(), "luac5.1 -p rejected the bundle");
    }
}
