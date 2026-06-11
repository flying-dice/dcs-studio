//! Process-wide tracing setup for the native binaries (the CLI,
//! `lua-analyzer`, the Tauri app).
//!
//! Events render to **stderr** — never stdout, which `lua-analyzer` (and the
//! CLI's `mcp`) reserve for the JSON-RPC protocol; a stray byte on stdout
//! corrupts the wire. The filter reads the `DCS_LOG` env var (e.g.
//! `DCS_LOG=debug`, or `DCS_LOG=lua_analyzer=trace,info`), falling back to
//! `default` when it is unset or unparseable.

use tracing_subscriber::EnvFilter;

/// Install the global stderr subscriber. Idempotent and never panics: a
/// second call (or one in a test where a subscriber is already set) is a
/// no-op via `try_init`.
pub fn init(default: &str) {
    let filter = EnvFilter::try_from_env("DCS_LOG").unwrap_or_else(|_| EnvFilter::new(default));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_target(true)
        .try_init();
}
