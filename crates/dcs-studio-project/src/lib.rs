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
//! - [`toolchain`] — detect the Rust toolchain for `rust-dll` builds.
//! - [`process`] — spawn child processes without console-window flashes.
//! - [`todos`] — workspace comment-tag scanner (Todos panel, issue #16).

pub mod detect;
pub mod install;
pub mod logging;
pub mod manifest;
pub mod process;
pub mod scaffold;
pub mod sources;
pub mod templates;
pub mod todos;
pub mod toolchain;

pub use detect::default_saved_games;
pub use install::{InstallReport, InstallStatus, RootMap, UninstallReport};
pub use manifest::{InstallRule, Manifest, ProjectMeta, format_config_for};
pub use process::quiet_command;
pub use templates::{TemplateContents, TemplateFile};
pub use toolchain::ToolchainStatus;
