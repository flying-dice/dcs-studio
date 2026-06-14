//! Small filesystem helpers shared across the crate: a deterministic file
//! walker and a tree copier (the package stages payloads before zipping/linking).

use std::path::{Path, PathBuf};

/// Every file under `root`, as `(relative-path-with-forward-slashes, abs-path)`,
/// recursively. Order is undefined here; callers that need determinism sort.
pub(crate) fn walk(root: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let mut out = Vec::new();
    walk_into(root, root, &mut out)?;
    Ok(out)
}

fn walk_into(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| format!("reading {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| format!("dir entry under {}: {e}", dir.display()))?;
        let path = entry.path();
        if path.is_dir() {
            walk_into(root, &path, out)?;
        } else {
            let rel = path
                .strip_prefix(root)
                .map_err(|e| format!("strip prefix: {e}"))?
                .to_string_lossy()
                .replace('\\', "/");
            out.push((rel, path));
        }
    }
    Ok(())
}

/// Copy a file or a directory tree from `src` to `dst`, creating parents.
pub(crate) fn copy_tree_or_file(src: &Path, dst: &Path) -> Result<(), String> {
    if src.is_dir() {
        for (rel, path) in walk(src)? {
            copy_file(&path, &dst.join(&rel))?;
        }
        // An empty source dir still materialises as a dir.
        std::fs::create_dir_all(dst).map_err(|e| format!("creating {}: {e}", dst.display()))?;
        Ok(())
    } else {
        copy_file(src, dst)
    }
}

fn copy_file(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("creating {}: {e}", parent.display()))?;
    }
    std::fs::copy(src, dst)
        .map(|_| ())
        .map_err(|e| format!("copying {} to {}: {e}", src.display(), dst.display()))
}
