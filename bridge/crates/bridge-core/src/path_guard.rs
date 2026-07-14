//! `stays_under` — vendored from dcs-studio-project's `install` module, the only
//! function `file`/`sqlite` need from it. A relative path is "contained" only if
//! every component is `Normal` (no `..`, no root, no drive prefix), so a guarded
//! write-root dump can never escape via `..` or an absolute path.
use std::path::{Component, Path};

/// True when `path` stays under its base — every component is a normal segment.
pub fn stays_under(path: &str) -> bool {
    Path::new(path)
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
}
