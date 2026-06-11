//! dcs-studio-cli — the agent-complete companion binary (decisions/005).
//!
//! Everything an agent needs without the Tauri app: `init` scaffolds a
//! project, `check` analyses a workspace, `lsp` serves the genuine
//! Language Server Protocol over stdio, `mcp` serves MCP tools over
//! stdio. The IDE's backend spawns `dcs-studio-cli lsp` as its Lua
//! language server.

mod check;
mod lsp;
mod mcp;
mod scaffold;
mod sources;
mod templates;

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "dcs-studio-cli",
    version,
    about = "DCS Studio companion CLI: project scaffolding, workspace checking, LSP and MCP over stdio"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serve the Lua language server over stdio (LSP).
    Lsp,
    /// Serve project tools over stdio (Model Context Protocol).
    Mcp,
    /// Scaffold a new project from a template.
    Init {
        /// Project name; also the new folder's name under --parent.
        name: String,
        /// Template id: `lua-script` or `blank`.
        #[arg(long, default_value = "lua-script")]
        template: String,
        /// Directory to create the project under.
        #[arg(long, default_value = ".")]
        parent: PathBuf,
    },
    /// Analyse a workspace; the exit code is the error-finding count.
    Check {
        /// Workspace root to analyse.
        #[arg(default_value = ".")]
        root: PathBuf,
    },
}

fn main() -> ExitCode {
    match Cli::parse().command {
        Command::Lsp => {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("tokio runtime construction cannot fail with default settings")
                .block_on(lsp::serve());
            ExitCode::SUCCESS
        }
        Command::Mcp => match mcp::serve() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("mcp: {error}");
                ExitCode::FAILURE
            }
        },
        Command::Init {
            name,
            template,
            parent,
        } => match scaffold::init(&template, &parent, &name) {
            Ok(root) => {
                println!("created {}", root.display());
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("init: {error}");
                ExitCode::FAILURE
            }
        },
        Command::Check { root } => {
            let report = check::run(&root);
            print!("{}", report.rendered);
            // Exit codes above 100 are reserved for runner failures.
            ExitCode::from(u8::try_from(report.error_count.min(100)).unwrap_or(100))
        }
    }
}
