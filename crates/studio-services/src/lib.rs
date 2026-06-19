//! studio-services — Tauri-free IDE service logic (issue #8).
//!
//! The filesystem, injection, launcher, mission-scripting, and DCS-link
//! services that used to live inside the Tauri app crate, extracted so the
//! IDE-hosted MCP tool surface (`crates/studio-mcp`) and the desktop app run
//! the exact same logic. The app's `#[tauri::command]`s are thin wrappers over
//! this crate.
//!
//! Stdout discipline: nothing in this crate prints.

// Test code is exempt from the production safety lints — indexing into
// known-shape fixtures, `panic!` on bad setup, and stderr debug are idiomatic
// there (unwrap/expect/dbg are exempted via clippy.toml).
#![cfg_attr(test, allow(clippy::indexing_slicing, clippy::panic, clippy::print_stderr))]

pub mod fs;
pub mod github;
mod github_http;
pub mod inject;
pub mod launcher;
pub mod link;
pub mod linker;
pub mod market;
pub mod mission;
pub mod publish;
pub mod term;
