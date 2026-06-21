//! Dependency resolution (model `studio::cargolua::DependencyResolver`). For
//! each dependency in `CargoLua.toml`, vendor into
//! `<root>/.lua-cargo/deps/<name>` (clone if absent, else fetch), check out its
//! selector, capture HEAD via `rev-parse`, and write a name-sorted
//! `CargoLua.lock`.
//!
//! Re-resolve is a no-op for a *pinned* dependency (tag/rev) already satisfied
//! by the lock and the on-disk checkout — a pinned ref never moves, so there is
//! nothing to fetch. A branch (or default-branch) dependency re-fetches so it
//! can advance to the branch tip.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::manifest::{self, CargoManifest, Dependency, Selector};
use crate::{CargoError, git};

/// The per-project vendor cache, relative to the project root.
const VENDOR_REL: &str = ".lua-cargo/deps";
/// The lockfile name.
const LOCK_FILE: &str = "CargoLua.lock";

/// One row of `CargoLua.lock`: the dependency name, its `owner/repo`, and the
/// resolved HEAD SHA.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockEntry {
    pub name: String,
    pub github: String,
    pub rev: String,
}

/// The outcome of a resolve: the lock rows (name-sorted) and the vendor
/// directory deps were checked out under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolveReport {
    pub entries: Vec<LockEntry>,
    pub vendor_dir: PathBuf,
}

/// The lockfile's serialized shape: `[[dep]]` tables, sorted by name.
#[derive(Debug, Default, Serialize, Deserialize)]
struct LockFile {
    #[serde(default, rename = "dep")]
    deps: Vec<LockEntry>,
}

/// Read and parse `<root>/CargoLua.lock`, or an empty lock when absent.
fn read_lock(root: &Path) -> LockFile {
    let path = root.join(LOCK_FILE);
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| toml::from_str(&text).ok())
        .unwrap_or_default()
}

/// Resolve every dependency of the project at `root`.
///
/// # Errors
///
/// A missing/malformed manifest ([`CargoError::Manifest`]), absent git
/// ([`CargoError::GitMissing`]), a failed clone/fetch
/// ([`CargoError::CloneFailed`]), or an unresolvable ref
/// ([`CargoError::RefNotFound`]).
pub fn resolve(root: &Path) -> Result<ResolveReport, CargoError> {
    let manifest = manifest::find_and_parse(root)?;

    if !manifest.dependencies.is_empty() && !git::git_available() {
        return Err(CargoError::GitMissing);
    }

    let vendor_dir = root.join(VENDOR_REL);
    let prior = read_lock(root);

    let mut entries = Vec::with_capacity(manifest.dependencies.len());
    // `dependencies` is a BTreeMap, so iteration — and the lock — is name-sorted.
    for (name, dep) in &manifest.dependencies {
        let rev = vendor_one(&vendor_dir, name, dep, &prior)?;
        entries.push(LockEntry {
            name: name.clone(),
            github: dep.github(),
            rev,
        });
    }

    write_lock(root, &entries)?;

    Ok(ResolveReport {
        entries,
        vendor_dir,
    })
}

/// Vendor one dependency and return its resolved HEAD SHA.
fn vendor_one(
    vendor_dir: &Path,
    name: &str,
    dep: &Dependency,
    prior: &LockFile,
) -> Result<String, CargoError> {
    let dir = vendor_dir.join(name);
    let exists = dir.join(".git").is_dir();

    let pinned = matches!(dep.selector, Selector::Tag(_) | Selector::Rev(_));
    let locked_rev = prior.deps.iter().find(|d| d.name == name).map(|d| &d.rev);

    // A pinned dep already vendored and locked needs no git work — a tag/rev
    // never moves. Verify the on-disk HEAD still matches the lock; if it does,
    // short-circuit.
    if exists && pinned {
        if let Some(want) = locked_rev {
            if let Ok(head) = git::rev_parse_head(&dir) {
                if &head == want {
                    return Ok(head);
                }
            }
        }
    }

    if exists {
        git::fetch(&dir)?;
    } else {
        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| CargoError::Io(format!("creating vendor dir: {e}")))?;
        }
        git::clone(&dep.clone_url(), &dir)?;
    }

    // Check out the selector. The default branch has no concrete name — its
    // fetch already moved `origin/HEAD`, so we resolve through it.
    match dep.selector.refname() {
        Some(refname) => git::checkout(&dir, refname)?,
        None => git::checkout(&dir, "origin/HEAD")?,
    }

    git::rev_parse_head(&dir)
}

/// Write the name-sorted lockfile.
fn write_lock(root: &Path, entries: &[LockEntry]) -> Result<(), CargoError> {
    let mut sorted = entries.to_vec();
    sorted.sort_by(|a, b| a.name.cmp(&b.name));
    let lock = LockFile { deps: sorted };
    let text = toml::to_string(&lock)
        .map_err(|e| CargoError::Io(format!("serializing lockfile: {e}")))?;
    std::fs::write(root.join(LOCK_FILE), text)
        .map_err(|e| CargoError::Io(format!("writing {LOCK_FILE}: {e}")))?;
    Ok(())
}

/// The resolved on-disk roots of each vendored dependency, keyed by name —
/// consumed by the bundler's module search. Reads `CargoLua.toml` to learn the
/// dependency names; missing checkouts are simply absent from the map.
///
/// # Errors
///
/// A missing or malformed manifest ([`CargoError::Manifest`]).
pub fn vendored_roots(root: &Path) -> Result<BTreeMap<String, PathBuf>, CargoError> {
    let manifest: CargoManifest = manifest::find_and_parse(root)?;
    let vendor_dir = root.join(VENDOR_REL);
    let mut roots = BTreeMap::new();
    for name in manifest.dependencies.keys() {
        let dir = vendor_dir.join(name);
        if dir.is_dir() {
            roots.insert(name.clone(), dir);
        }
    }
    Ok(roots)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// A throwaway directory tree, removed on drop.
    struct TempTree(PathBuf);

    impl TempTree {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "lua-cargo-resolve-{tag}-{}-{}",
                std::process::id(),
                fastish()
            ));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).expect("create temp root");
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

    fn fastish() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    }

    /// Run a git command in `dir`, failing the test on error.
    fn git_in(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(dir)
            .args(args)
            .status()
            .expect("spawn git");
        assert!(status.success(), "git {args:?} failed");
    }

    /// Init a local git repo with one commit on a tag, return its path.
    fn make_fixture_repo(tag: &str) -> TempTree {
        let repo = TempTree::new("fixture");
        git_in(&repo.0, &["init", "-q"]);
        git_in(&repo.0, &["config", "user.email", "t@t.test"]);
        git_in(&repo.0, &["config", "user.name", "Tester"]);
        // Give the default branch a stable name for origin/HEAD resolution.
        git_in(&repo.0, &["checkout", "-q", "-b", "main"]);
        repo.write("init.lua", "return 1\n");
        git_in(&repo.0, &["add", "-A"]);
        git_in(&repo.0, &["commit", "-q", "-m", "first"]);
        git_in(&repo.0, &["tag", tag]);
        repo
    }

    #[test]
    fn resolve_checks_out_tag_and_writes_lock() {
        if !git::git_available() {
            return; // skip cleanly without git
        }
        let fixture = make_fixture_repo("1.0.0");
        let fixture_url = url_for(&fixture.0);

        let project = TempTree::new("project");
        project.write(
            "CargoLua.toml",
            "[package]\nname = \"p\"\n[dependencies]\ndep = { github = \"local/dep\", tag = \"1.0.0\" }\n",
        );

        // Point the clone at the local fixture by pre-seeding the vendor dir via
        // a direct clone (resolve() would build a github.com URL otherwise).
        let vendor = project.0.join(VENDOR_REL).join("dep");
        std::fs::create_dir_all(vendor.parent().unwrap()).unwrap();
        git_in(&project.0, &["clone", "-q", &fixture_url, vendor.to_str().unwrap()]);

        let report = resolve(&project.0).expect("resolve");
        assert_eq!(report.entries.len(), 1);
        let entry = &report.entries[0];
        assert_eq!(entry.name, "dep");
        assert_eq!(entry.github, "local/dep");
        assert_eq!(entry.rev.len(), 40, "full sha captured");

        // Lockfile written and parseable, with the same rev.
        let lock_text = std::fs::read_to_string(project.0.join(LOCK_FILE)).expect("lock");
        assert!(lock_text.contains("[[dep]]"));
        let parsed: LockFile = toml::from_str(&lock_text).expect("lock parses");
        assert_eq!(parsed.deps.len(), 1);
        assert_eq!(parsed.deps[0].rev, entry.rev);

        // Re-resolve is a no-op for the pinned tag: same bytes.
        let before = std::fs::read(project.0.join(LOCK_FILE)).unwrap();
        let report2 = resolve(&project.0).expect("re-resolve");
        assert_eq!(report2.entries[0].rev, entry.rev);
        let after = std::fs::read(project.0.join(LOCK_FILE)).unwrap();
        assert_eq!(before, after, "re-resolve deterministic");
    }

    /// A `file://` URL for a local path (forward slashes; git accepts it).
    fn url_for(path: &Path) -> String {
        let s = path.to_string_lossy().replace('\\', "/");
        format!("file:///{}", s.trim_start_matches('/'))
    }
}
