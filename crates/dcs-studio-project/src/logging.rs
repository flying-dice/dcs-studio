//! Process-wide tracing setup for the native binaries (the CLI,
//! `lua-analyzer`, the Tauri app).
//!
//! Events render to **stderr** — never stdout, which `lua-analyzer` (and the
//! CLI's `mcp`) reserve for the JSON-RPC protocol; a stray byte on stdout
//! corrupts the wire. The filter reads the `DCS_LOG` env var (e.g.
//! `DCS_LOG=debug`, or `DCS_LOG=lua_analyzer=trace,info`), falling back to
//! `default` when it is unset or unparseable.
//!
//! [`init_to_file`] additionally tees every event to a log file — the app
//! uses it (and folds each hosted language server's stderr into its own
//! events), so one file on disk holds the whole picture for debugging.

use std::fs::OpenOptions;
use std::path::Path;
use std::sync::Mutex;

use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::writer::MakeWriterExt;

/// The default log file location: `<temp>/dcs-studio.log`. A stable absolute
/// path so it can be found without knowing the process's working directory.
#[must_use]
pub fn default_log_path() -> std::path::PathBuf {
    std::env::temp_dir().join("dcs-studio.log")
}

/// Install the global stderr subscriber. Idempotent and never panics: a
/// second call (or one in a test where a subscriber is already set) is a
/// no-op via `try_init`.
pub fn init(default: &str) {
    let _ = base(default).with_writer(std::io::stderr).try_init();
}

/// Like [`init`], but also appends every event to `path` (an append-mode
/// file behind a `Mutex`, so writes never interleave). Falls back to
/// stderr-only when the file cannot be opened. Returns the path actually
/// logged to (for a startup message), or `None` on fallback.
pub fn init_to_file(default: &str, path: &Path) -> Option<std::path::PathBuf> {
    let Ok(file) = OpenOptions::new().create(true).append(true).open(path) else {
        init(default);
        return None;
    };
    let _ = base(default)
        .with_writer(std::io::stderr.and(Mutex::new(file)))
        .try_init();
    Some(path.to_path_buf())
}

fn base(
    default: &str,
) -> tracing_subscriber::fmt::SubscriberBuilder<
    tracing_subscriber::fmt::format::DefaultFields,
    tracing_subscriber::fmt::format::Format,
    EnvFilter,
> {
    let filter = EnvFilter::try_from_env("DCS_LOG").unwrap_or_else(|_| EnvFilter::new(default));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true)
        .with_ansi(false)
}
