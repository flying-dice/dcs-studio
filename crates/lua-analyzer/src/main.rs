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

fn main() {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime construction cannot fail with default settings")
        .block_on(server::serve());
}
