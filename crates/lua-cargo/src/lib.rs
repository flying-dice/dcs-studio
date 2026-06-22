//! lua-cargo — a Cargo-shaped toolchain for DCS Lua mods (issue #48 Part A;
//! model `studio::cargolua`).
//!
//! Two halves joined under `CargoLua.toml`:
//!
//! - a **git dependency manager** ([`resolve`]) that vendors
//!   `github = "owner/repo"` dependencies (pinned by `branch`/`tag`/`rev`) into
//!   a per-project cache under `.lua-cargo/deps/`, captures each resolved HEAD
//!   SHA, and records them in a name-sorted `CargoLua.lock` for reproducibility;
//! - a **require-graph bundler/amalgamator** ([`bundle`]) that walks an entry
//!   script's `require("mod")` graph and folds every reachable module into one
//!   self-contained Lua 5.1 file behind a `__require` shim — sources copied
//!   verbatim, no AST rewrite, no code execution.
//!
//! Dependency fetching shells out to the installed `git` (one mechanism, no
//! embedded git); see [`git`]. The crate is deliberately lean — it does not
//! depend on `dcs-studio-project`.

// Test code is exempt from the production safety lints — indexing into
// known-shape fixtures and `panic!` on bad setup are idiomatic there (the same
// exemption the engine crates take; clippy.toml already exempts unwrap/expect).
#![cfg_attr(test, allow(clippy::indexing_slicing, clippy::panic, clippy::print_stderr, clippy::print_stdout))]

pub mod bundle;
pub mod git;
pub mod manifest;
pub mod resolve;

use std::fmt;
use std::path::Path;

pub use bundle::{BundleReport, bundle, bundle_with_progress};
pub use manifest::{
    BundleTarget, CargoManifest, Dependency, PackageMeta, Selector, find_and_parse, parse,
};
pub use resolve::{LockEntry, ResolveReport, resolve, resolve_with_progress};

/// A lua-cargo toolchain failure. A plain enum (no `thiserror`) carrying a
/// human-readable message in the variants the model discloses; `Display` flattens
/// to the message so the CLI can print it directly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CargoError {
    /// `CargoLua.toml` is missing, unreadable, or malformed.
    Manifest(String),
    /// The `git` binary is not on `PATH`.
    GitMissing,
    /// A `git clone`/`fetch` failed (network, auth, bad repo).
    CloneFailed(String),
    /// A requested ref (branch/tag/rev) does not exist in the remote.
    RefNotFound(String),
    /// A `[[bundle]]` entry path does not exist on disk.
    MissingEntry(String),
    /// A filesystem operation failed (read/write/create-dir).
    Io(String),
    /// A `git` invocation failed for a reason none of the above name.
    Git(String),
}

impl fmt::Display for CargoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Manifest(m) => write!(f, "manifest error: {m}"),
            Self::GitMissing => write!(f, "git not found on PATH"),
            Self::CloneFailed(m) => write!(f, "git clone/fetch failed: {m}"),
            Self::RefNotFound(m) => write!(f, "git ref not found: {m}"),
            Self::MissingEntry(m) => write!(f, "bundle entry not found: {m}"),
            Self::Io(m) => write!(f, "io error: {m}"),
            Self::Git(m) => write!(f, "git error: {m}"),
        }
    }
}

impl std::error::Error for CargoError {}

/// Resolve the project's dependencies, then bundle every `[[bundle]]` target —
/// the `build` subcommand's whole job.
///
/// # Errors
///
/// Any [`resolve`] or [`bundle`] failure (see [`CargoError`]).
pub fn build(root: &Path) -> Result<(ResolveReport, BundleReport), CargoError> {
    let resolved = resolve(root)?;
    let bundled = bundle(root)?;
    Ok((resolved, bundled))
}
