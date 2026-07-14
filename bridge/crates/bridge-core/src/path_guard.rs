//! The DCS write-root guard shared by `file` and `sqlite`. [`stays_under`] is
//! vendored from dcs-studio-project's `install` module: a relative path is
//! "contained" only if every component is `Normal` (no `..`, no root, no drive
//! prefix), so a guarded write-root dump can never escape via `..` or an
//! absolute path. [`resolve_under_writedir`] layers `lfs.writedir()` resolution
//! on top — both writers confine to the same root with the same guard and error
//! strings, so that logic lives here once.
use crate::get_lfs_writedir;
use mlua::Lua;
use std::path::{Component, Path, PathBuf};

/// True when `path` stays under its base — every component is a normal segment.
pub fn stays_under(path: &str) -> bool {
    Path::new(path)
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
}

/// Resolve `rel` under `lfs.writedir()`, refusing any path that escapes the
/// write root. Shared by `file` and `sqlite`.
///
/// # Errors
///
/// Returns an error string when `rel` escapes the write root (absolute,
/// drive-prefixed, or climbing out with `..`), or when `lfs.writedir()` is
/// unavailable in `lua`.
pub fn resolve_under_writedir(lua: &Lua, rel: &str) -> Result<PathBuf, String> {
    if !stays_under(rel) {
        return Err(format!("path escapes the write root: {rel}"));
    }
    let writedir = get_lfs_writedir(lua).map_err(|e| format!("lfs.writedir() unavailable: {e}"))?;
    Ok(PathBuf::from(writedir).join(rel))
}
