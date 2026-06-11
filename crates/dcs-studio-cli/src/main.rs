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
mod sources;

use std::path::{Path, PathBuf};
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
        /// Template id: `lua-script`, `rust-dll`, or `blank`.
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
    /// Build the project: `cargo build --release` for Rust projects,
    /// a no-op for everything else.
    Build {
        /// Project root.
        #[arg(default_value = ".")]
        root: PathBuf,
    },
    /// Apply the manifest's [[install]] rules to your DCS folders.
    Install {
        /// Project root.
        #[arg(default_value = ".")]
        root: PathBuf,
        /// DCS "Saved Games" folder; auto-detected when omitted.
        #[arg(long)]
        saved_games: Option<PathBuf>,
        /// DCS game install directory, for `{GameInstall}` rules.
        #[arg(long)]
        game_install: Option<PathBuf>,
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
        } => match dcs_studio_project::scaffold::init(&template, &parent, &name) {
            Ok(root) => {
                println!("created {}", root.display());
                // Per-template guidance (model: `studio::cli::Cli.PrintNextSteps`).
                let steps = dcs_studio_project::templates::next_steps(&template);
                if !steps.is_empty() {
                    println!("{steps}");
                }
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
        Command::Build { root } => build(&root),
        Command::Install {
            root,
            saved_games,
            game_install,
        } => install(&root, saved_games, game_install),
    }
}

/// `cargo build --release` with inherited stdio; non-Rust roots are a no-op
/// (model: `studio::build::Builder.RunBuild`).
fn build(root: &Path) -> ExitCode {
    if !root.join("Cargo.toml").is_file() {
        println!("no build step (not a Rust project)");
        return ExitCode::SUCCESS;
    }
    if dcs_studio_project::toolchain::detect().cargo.is_none() {
        eprintln!("build: cargo not found — install the Rust toolchain via https://rustup.rs");
        return ExitCode::FAILURE;
    }
    match dcs_studio_project::quiet_command("cargo")
        .args(["build", "--release"])
        .current_dir(root)
        .status()
    {
        Ok(status) if status.success() => ExitCode::SUCCESS,
        // Pass cargo's exit code through; a signal death maps to failure.
        Ok(status) => status
            .code()
            .and_then(|code| u8::try_from(code).ok())
            .map_or(ExitCode::FAILURE, ExitCode::from),
        Err(error) => {
            eprintln!("build: running cargo: {error}");
            ExitCode::FAILURE
        }
    }
}

/// Apply the manifest's install rules against detected (or given) roots
/// (model: `studio::installer::Installer.InstallProject`).
fn install(root: &Path, saved_games: Option<PathBuf>, game_install: Option<PathBuf>) -> ExitCode {
    let Some(saved_games) = saved_games.or_else(dcs_studio_project::default_saved_games) else {
        eprintln!("install: no DCS Saved Games folder found — pass --saved-games <path>");
        return ExitCode::FAILURE;
    };
    let roots = dcs_studio_project::RootMap {
        saved_games,
        game_install,
    };
    match dcs_studio_project::install::install(root, &roots) {
        Ok(report) => {
            println!("installed {} file(s)", report.copied);
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("install: {error}");
            ExitCode::FAILURE
        }
    }
}
