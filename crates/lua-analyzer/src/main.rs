//! lua-analyzer — the DCS Lua language server, a standalone LSP binary.
//!
//! Hosted exactly like rust-analyzer (decisions/005): the IDE's backend
//! spawns it as a child process and pumps framed JSON-RPC over stdio; any
//! LSP client (editors, agents) can run it directly. `initialize` carries the
//! workspace `rootUri`, which the server walks for Lua sources, so
//! workspace-wide diagnostics publish from boot without the client opening
//! every file.
//!
//! The analysis engine itself lives in `dcs-lua-lsp-core`; this crate is the
//! LSP edge over it (positions in UTF-16, the protocol default).

mod server;

fn main() -> std::io::Result<()> {
    // Logs go to STDERR (stdout is the LSP wire). Raise verbosity with e.g.
    // `DCS_LOG=lua_analyzer=trace,info`. The host captures this stderr and
    // folds it into the app's own log, so a crash here is visible there.
    dcs_studio_project::logging::init("info");
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "lua-analyzer starting");
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(server::serve());
    Ok(())
}
