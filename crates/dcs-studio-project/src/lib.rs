//! dcs-studio-project — the shared project kit behind DCS Studio's CLI and
//! IDE (model: `studio::build`, `studio::installer`, issue #6 R1).
//!
//! One crate owns what a "project" is so every surface agrees:
//!
//! - [`templates`] — render the starter templates (`lua-script`, `rust-dll`,
//!   `blank`) to in-memory files.
//! - [`scaffold`] — materialise a template on disk.
//! - [`manifest`] — parse `dcs-studio.toml` (tolerantly).
//! - [`install`] — apply the manifest's `[[install]]` rules to the local
//!   machine's named roots (`{SavedGames}`, `{GameInstall}`).
//! - [`detect`] — find the local DCS Saved Games write dir.
//! - [`find`] — project-wide find-in-files (search overlay, issue #68).
//! - [`mcp`] — the IDE's MCP endpoint (issue #39), shared so the scaffolded
//!   `.mcp.json` and the app's server can't drift.
//! - [`toolchain`] — detect the Rust toolchain for `rust-dll` builds.
//! - [`process`] — spawn child processes without console-window flashes.
//! - [`todos`] — workspace comment-tag scanner (Todos panel, issue #16).

// Test code is exempt from the production safety lints — indexing into
// known-shape fixtures and `panic!` on bad setup are idiomatic there
// (unwrap/expect/dbg via clippy.toml).
#![cfg_attr(test, allow(clippy::indexing_slicing, clippy::panic, clippy::print_stderr))]

pub mod detect;
pub mod find;
pub mod install;
pub mod logging;
pub mod luadef;
pub mod manifest;
pub mod mcp;
pub mod process;
pub mod scaffold;
pub mod sources;
pub mod templates;
pub mod todos;
pub mod toolchain;

pub use detect::default_saved_games;
pub use install::{InstallReport, InstallStatus, RootMap, UninstallReport};
pub use manifest::{DependencyRule, InstallRule, Manifest, ProjectMeta, format_config_for};
pub use process::quiet_command;
pub use templates::{TemplateContents, TemplateFile};
pub use toolchain::ToolchainStatus;

/// The GitHub topic that marks a public repo as a dcs-studio mod: the Marketplace
/// discovers by it (`studio::market`) and `share` tags every repo with it
/// (`studio::publish`), so the reader and writer agree by sharing this one const.
pub const DISCOVERY_TOPIC: &str = "dcs-studio";

/// The GitHub topic that marks a discovered repo as a LIBRARY (issue #48): a
/// shared Lua dependency, discoverable + "Add as dependency"-able but NEVER
/// installable into DCS. Reader (market) and writer (publish) share this const.
pub const LIBRARY_TOPIC: &str = "dcs-studio-library";

/// The project manifest filename — at the project root, and uploaded as a release
/// asset so the Marketplace reads the install plan without the whole payload. The
/// single source the writer (publish) and reader (discovery) share.
pub const MANIFEST_FILE: &str = "dcs-studio.toml";
