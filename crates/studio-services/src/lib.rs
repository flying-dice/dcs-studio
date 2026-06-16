//! studio-services — Tauri-free IDE service logic (issue #8).
//!
//! The filesystem, injection, launcher, mission-scripting, and DCS-link
//! services that used to live inside the Tauri app crate, extracted so the
//! IDE-hosted MCP tool surface (`crates/studio-mcp`) and the desktop app run
//! the exact same logic. The app's `#[tauri::command]`s are thin wrappers over
//! this crate.
//!
//! Stdout discipline: nothing in this crate prints.

pub mod fs;
pub mod github;
pub mod inject;
pub mod launcher;
pub mod link;
pub mod mission;
pub mod term;
