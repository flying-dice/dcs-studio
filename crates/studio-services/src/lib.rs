//! studio-services — Tauri-free IDE service logic (issue #8).
//!
//! The filesystem, injection, mission-scripting, and DCS-link services that
//! used to live inside the Tauri app crate, extracted so the headless MCP
//! server (`dcs-studio-cli mcp`) and the desktop app run the exact same
//! logic. The app's `#[tauri::command]`s are thin wrappers over this crate.
//!
//! Stdout discipline: nothing in this crate prints — the MCP host's stdout
//! is the protocol wire.

pub mod fs;
pub mod inject;
pub mod link;
pub mod mission;
