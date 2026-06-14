//! Placement — per-file symlink with copy fallback (model
//! `PackageLibrary.PlaceLinks`).
//!
//! Install rules drop files INTO shared destination directories (a file rule →
//! `dest/<name>`, a dir rule → `dest/<rel>` per file), so a whole-directory
//! junction would hide co-located files — placement is per file. Each
//! destination is a symlink into the content store when the OS allows it (on
//! Windows file symlinks need Developer Mode); otherwise a copy. The mode is
//! recorded per link so uninstall removes exactly what was placed.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// How a destination was placed.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LinkMode {
    Symlink,
    Copy,
}

/// One placed destination and how it was placed (the uninstall ledger entry).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlacedLink {
    pub path: String,
    pub mode: LinkMode,
}

/// Place `dest` pointing at `target` (a file in the content store): a symlink
/// when the OS allows it, else a copy. Creates `dest`'s parent. Refuses to
/// clobber an existing `dest`.
///
/// # Errors
/// Returns `Err` when `dest` already exists or neither symlink nor copy
/// succeeds.
pub fn place_file(target: &Path, dest: &Path) -> Result<LinkMode, String> {
    if dest.symlink_metadata().is_ok() {
        return Err(format!("{} already exists", dest.display()));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("creating {}: {e}", parent.display()))?;
    }
    if symlink_file(target, dest).is_ok() {
        return Ok(LinkMode::Symlink);
    }
    std::fs::copy(target, dest)
        .map(|_| LinkMode::Copy)
        .map_err(|e| format!("linking/copying to {}: {e}", dest.display()))
}

/// Remove a placed destination (symlink or copy — both are a single file).
///
/// # Errors
/// Returns `Err` only when removal of an existing entry fails.
pub fn remove(path: &Path) -> Result<(), String> {
    if path.symlink_metadata().is_err() {
        return Ok(()); // already gone
    }
    std::fs::remove_file(path).map_err(|e| format!("removing {}: {e}", path.display()))
}

#[cfg(unix)]
fn symlink_file(target: &Path, dest: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, dest)
}

#[cfg(windows)]
fn symlink_file(target: &Path, dest: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(target, dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn place_file_refuses_to_clobber_an_existing_destination() {
        let dir = std::env::temp_dir().join(format!("pkg-clobber-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("source.txt");
        let dest = dir.join("dest.txt");
        std::fs::write(&target, "store").unwrap();
        std::fs::write(&dest, "precious user file").unwrap();

        let err = place_file(&target, &dest).expect_err("must refuse to clobber");
        assert!(err.contains("already exists"), "{err}");
        // The pre-existing file is untouched.
        assert_eq!(
            std::fs::read_to_string(&dest).unwrap(),
            "precious user file"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
