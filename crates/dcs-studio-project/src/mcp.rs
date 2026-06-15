//! The IDE's hosted MCP endpoint — the one contract the project scaffold and
//! the app's MCP server (issue #39) must agree on.
//!
//! It lives in the shared project kit, not the app, because the CLI scaffolds a
//! project's `.mcp.json` (pointing an editor at the IDE) without the app
//! running, while the app's server (`crates/app/src/mcp.rs`) binds the same
//! fixed port. Both read these constants, so the scaffold and the server can
//! never drift.

/// The fixed loopback port the IDE serves MCP on. One IDE per machine, so it is
/// well-known and stable — a bootstrapped `.mcp.json` and every editor's config
/// can hard-code it. Sits next to the in-DCS bridge's `25569`.
pub const MCP_PORT: u16 = 25570;

/// The Streamable HTTP endpoint path the SDK mounts under.
pub const MCP_PATH: &str = "/mcp";

/// The full Streamable HTTP endpoint for `port`, e.g. `http://127.0.0.1:25570/mcp`.
#[must_use]
pub fn url_for(port: u16) -> String {
    format!("http://127.0.0.1:{port}{MCP_PATH}")
}

/// The endpoint on the fixed port — what a bootstrapped `.mcp.json` and every
/// editor config point at.
#[must_use]
pub fn url() -> String {
    url_for(MCP_PORT)
}
