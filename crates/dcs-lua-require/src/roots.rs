//! The module-name → file-path mapping (model `studio::cargolua::ModuleResolver`).
//!
//! [`SearchRoots`] is the single authority on where `require("a.b")` lives. It
//! is the path mapping lifted verbatim out of the lua-cargo bundler so the
//! editor and the bundler resolve through the SAME code — the parity goal of
//! issue #51: a require resolves to the same file in both, or is unresolved in
//! both, never one-but-not-the-other.
//!
//! The mapping is IO-agnostic. [`SearchRoots::resolve_all`] takes an existence
//! predicate, so the consumer decides what "exists" means:
//!
//! - the **bundler** passes `|p| p.is_file()` — files on disk;
//! - the **editor** passes workspace membership — files mounted in the analyzer.
//!
//! The analyzer walks exactly the trees the bundler reads (the project plus the
//! vendored `.lua-cargo/deps/<name>` roots), so the two existence sets agree and
//! parity holds.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The directories a module name is resolved against, in priority order.
///
/// Construction differs between consumers in exactly one root — the first:
/// the **editor** passes the open file as `from_file`, the **bundler** the
/// `[[bundle]]` entry. Every other root (the project, `<root>/src`, the vendor
/// parent, each vendored dep) is identical, so a require of a project module or
/// a vendored dependency resolves the same regardless of which file you are in.
#[derive(Debug, Clone)]
pub struct SearchRoots {
    roots: Vec<PathBuf>,
}

impl SearchRoots {
    /// Build the priority-ordered, de-duplicated search roots for resolving
    /// requires that appear in `from_file` (the open file in the editor, the
    /// bundle entry in the bundler) within the project at `root`, against the
    /// `vendored` dependency checkouts (name → `.lua-cargo/deps/<name>`).
    ///
    /// Priority: the requiring file's own directory, the project root,
    /// `<root>/src`, the vendor parent (so a bare `require("moose")` finds
    /// `.lua-cargo/deps/moose/init.lua`), then each vendored dep root and its
    /// `src`/`lua` subdirectories.
    #[must_use]
    pub fn new(root: &Path, from_file: &Path, vendored: &BTreeMap<String, PathBuf>) -> Self {
        let mut roots = Vec::new();
        if let Some(dir) = from_file.parent() {
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

    /// Every DISTINCT file a module name `a.b` resolves to across the search
    /// roots (`a/b.lua` or `a/b/init.lua`), in search-root order, where `exists`
    /// reports whether a candidate file is part of the analyzed set (on disk for
    /// the bundler, mounted for the editor).
    ///
    /// The first hit is the one chosen; more than one is a collision the caller
    /// surfaces as a shadowing warning (a supply-chain hazard — a local file
    /// silently overriding a vendored dep, or vice versa). An empty result is an
    /// unresolved require (a host / DCS built-in) — a warning, never an error.
    ///
    /// De-duplication is by path equality (the roots are already de-duped and
    /// candidates are deterministic joins), so it is pure — no canonicalisation,
    /// hence no filesystem access, so the editor resolves with the same code.
    pub fn resolve_all<F: Fn(&Path) -> bool>(&self, module: &str, exists: F) -> Vec<PathBuf> {
        let rel = module.replace('.', "/");
        let mut hits: Vec<PathBuf> = Vec::new();
        for base in &self.roots {
            let flat = base.join(format!("{rel}.lua"));
            let candidate = if exists(&flat) {
                flat
            } else {
                let init = base.join(&rel).join("init.lua");
                if exists(&init) { init } else { continue }
            };
            if !hits.contains(&candidate) {
                hits.push(candidate);
            }
        }
        hits
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An existence predicate over a fixed set of relative paths under a root.
    fn present(root: &Path, rels: &[&str]) -> impl Fn(&Path) -> bool {
        let set: Vec<PathBuf> = rels.iter().map(|r| root.join(r)).collect();
        move |p: &Path| set.contains(&p.to_path_buf())
    }

    fn vendored(root: &Path, names: &[&str]) -> BTreeMap<String, PathBuf> {
        names
            .iter()
            .map(|n| (n.to_string(), root.join(".lua-cargo/deps").join(n)))
            .collect()
    }

    #[test]
    fn dotted_module_maps_to_flat_then_init() {
        let root = Path::new("/proj");
        let entry = root.join("src/main.lua");
        let roots = SearchRoots::new(root, &entry, &BTreeMap::new());

        // `a.b` → `src/a/b.lua` (flat form, found in the entry dir).
        let hits = roots.resolve_all("a.b", present(root, &["src/a/b.lua"]));
        assert_eq!(hits, vec![root.join("src/a/b.lua")]);

        // …or `src/a/b/init.lua` (package form) when the flat file is absent.
        let hits = roots.resolve_all("a.b", present(root, &["src/a/b/init.lua"]));
        assert_eq!(hits, vec![root.join("src/a/b/init.lua")]);
    }

    #[test]
    fn bare_dep_resolves_under_the_vendor_parent() {
        let root = Path::new("/proj");
        let entry = root.join("src/main.lua");
        let deps = vendored(root, &["moose"]);
        let roots = SearchRoots::new(root, &entry, &deps);

        // `require("moose")` → `.lua-cargo/deps/moose/init.lua` via the vendor
        // parent root — the file the bundler picks too.
        let hits = roots.resolve_all("moose", present(root, &[".lua-cargo/deps/moose/init.lua"]));
        assert_eq!(hits, vec![root.join(".lua-cargo/deps/moose/init.lua")]);
    }

    #[test]
    fn a_module_in_two_roots_is_a_shadowing_collision() {
        let root = Path::new("/proj");
        let entry = root.join("src/main.lua");
        let deps = vendored(root, &["shared"]);
        let roots = SearchRoots::new(root, &entry, &deps);

        // `shared` exists BOTH locally (src/shared.lua) and vendored — two hits,
        // the local one chosen first; the caller warns shadowing.
        let hits = roots.resolve_all(
            "shared",
            present(root, &["src/shared.lua", ".lua-cargo/deps/shared/init.lua"]),
        );
        assert_eq!(hits.len(), 2, "{hits:?}");
        assert_eq!(hits[0], root.join("src/shared.lua"), "local wins first");
        assert_eq!(hits[1], root.join(".lua-cargo/deps/shared/init.lua"));
    }

    #[test]
    fn unresolved_module_has_no_hits() {
        let root = Path::new("/proj");
        let entry = root.join("src/main.lua");
        let roots = SearchRoots::new(root, &entry, &BTreeMap::new());
        // A host module (`socket`) is on no search root — empty, the caller's
        // unresolved-require warning, never an error.
        assert!(roots.resolve_all("socket", present(root, &[])).is_empty());
    }

    #[test]
    fn only_the_requiring_files_own_directory_differs() {
        let root = Path::new("/proj");
        let deps = vendored(root, &["moose"]);
        // Two files in sibling directories. The requiring file's OWN directory
        // is the only search root that differs between them, so:
        let from_a = SearchRoots::new(root, &root.join("src/a/x.lua"), &deps);
        let from_b = SearchRoots::new(root, &root.join("src/b/y.lua"), &deps);

        // …a sibling module reachable only via a file's own dir resolves for
        // that file and not the other — the editor-vs-entry difference.
        let local = present(root, &["src/a/helper.lua"]);
        assert_eq!(from_a.resolve_all("helper", &local), vec![root.join("src/a/helper.lua")]);
        assert!(from_b.resolve_all("helper", &local).is_empty());

        // …but a vendored dep (a shared root) resolves identically from either —
        // the parity that matters: a dependency require agrees in both.
        let dep = present(root, &[".lua-cargo/deps/moose/init.lua"]);
        assert_eq!(
            from_a.resolve_all("moose", &dep),
            from_b.resolve_all("moose", &dep),
        );
        assert_eq!(from_a.resolve_all("moose", &dep), vec![root.join(".lua-cargo/deps/moose/init.lua")]);
    }
}
