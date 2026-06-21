//! Workspace source collection — the `.lua` walk shared by the CLI
//! (`check`, `fmt`, the MCP `check` tool) and the `lua-analyzer` LSP
//! server's initialize walk.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use walkdir::WalkDir;

/// Folders never analysed.
const SKIPPED_DIRS: &[&str] = &[".git", "node_modules", "target", "build"];

/// Every readable `.lua` / `.d.lua` file under `root` as `(path, text)`,
/// paths rendered platform-native. Unreadable files are skipped — one
/// locked file never takes analysis down.
///
/// `extra_roots` are trees walked in addition to `root`, each as a root of its
/// own — the escape hatch for vendored dependency sources under
/// `.lua-cargo/deps/<name>`, which the dot-prefixed skip below otherwise hides.
/// The analyzer passes the resolved vendor roots
/// (`lua_cargo::resolve::vendored_roots`) so editor intelligence reaches dep
/// modules without loosening the general dot-dir skip. A file reachable from
/// more than one root is collected once.
#[must_use]
pub fn collect(root: &Path, extra_roots: &[PathBuf]) -> Vec<(String, String)> {
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for tree in std::iter::once(root).chain(extra_roots.iter().map(PathBuf::as_path)) {
        for (path, text) in collect_tree(tree) {
            if seen.insert(path.clone()) {
                files.push((path, text));
            }
        }
    }
    files
}

/// Walk one tree for `.lua` sources. The tree root itself always walks — so a
/// dot-named root (a vendored `.lua-cargo/deps/<dep>`, or the literal `.` given
/// to `fmt .` / `check .`) is never tripped over; below it, dot-dirs and
/// `SKIPPED_DIRS` are pruned.
fn collect_tree(root: &Path) -> Vec<(String, String)> {
    WalkDir::new(root)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            !(entry.file_type().is_dir()
                && (SKIPPED_DIRS.contains(&name.as_ref()) || name.starts_with('.')))
        })
        .filter_map(std::result::Result::ok)
        .filter(|entry| {
            entry.file_type().is_file()
                && entry
                    .path()
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("lua"))
        })
        .filter_map(|entry| {
            let text = fs::read_to_string(entry.path()).ok()?;
            Some((entry.path().display().to_string(), text))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway directory tree, removed on drop.
    struct TempTree(PathBuf);

    impl TempTree {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "dcs-sources-{tag}-{}-{}",
                std::process::id(),
                fastish()
            ));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).expect("create temp root");
            TempTree(root)
        }
        fn write(&self, rel: &str, contents: &str) {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
            fs::write(path, contents).expect("write file");
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fastish() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos())
    }

    /// The file names of a collected set (order-independent assertions).
    fn names(files: &[(String, String)]) -> Vec<String> {
        files
            .iter()
            .filter_map(|(p, _)| Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()))
            .collect()
    }

    #[test]
    fn collects_lua_and_skips_dot_skipped_and_vendor_dirs() {
        let tree = TempTree::new("plain");
        tree.write("main.lua", "return 1\n");
        tree.write("src/mod.lua", "return 2\n");
        tree.write(".git/config", "[core]\n");
        tree.write("target/junk.lua", "return 0\n");
        tree.write(".lua-cargo/deps/moose/init.lua", "return 3\n");

        let got = names(&collect(&tree.0, &[]));
        assert!(got.contains(&"main.lua".to_string()), "missing main.lua: {got:?}");
        assert!(got.contains(&"mod.lua".to_string()), "missing src/mod.lua: {got:?}");
        // `target/` and the dot-prefixed vendor cache stay skipped without an
        // explicit extra root.
        assert!(!got.contains(&"junk.lua".to_string()), "target/ was walked: {got:?}");
        assert!(
            !got.contains(&"init.lua".to_string()),
            "vendor cache walked without an extra root: {got:?}"
        );
    }

    #[test]
    fn extra_root_pulls_in_a_vendored_dependency() {
        let tree = TempTree::new("vendor");
        tree.write("main.lua", "return 1\n");
        tree.write(".lua-cargo/deps/moose/init.lua", "return 3\n");
        tree.write(".lua-cargo/deps/moose/sub/util.lua", "return 4\n");
        // A vendored dep carries its own `.git` — still pruned inside the
        // extra root, the same as any nested skipped dir.
        tree.write(".lua-cargo/deps/moose/.git/config", "[core]\n");

        let dep_root = tree.0.join(".lua-cargo").join("deps").join("moose");
        let got = names(&collect(&tree.0, &[dep_root]));
        assert!(got.contains(&"main.lua".to_string()), "missing main.lua: {got:?}");
        assert!(
            got.contains(&"init.lua".to_string()),
            "vendored .lua-cargo/deps/moose/init.lua not collected: {got:?}"
        );
        assert!(
            got.contains(&"util.lua".to_string()),
            "nested vendored module not collected: {got:?}"
        );
    }

    #[test]
    fn a_file_reachable_from_two_roots_is_collected_once() {
        let tree = TempTree::new("dedup");
        tree.write("only.lua", "return 1\n");
        // Pass the root again as an extra root: dedup keeps a single entry.
        let got = names(&collect(&tree.0, std::slice::from_ref(&tree.0)));
        assert_eq!(got, vec!["only.lua".to_string()], "duplicate collection: {got:?}");
    }
}
