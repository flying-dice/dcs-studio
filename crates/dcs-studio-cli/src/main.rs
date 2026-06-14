//! dcs-studio-cli — the agent-complete companion binary (decisions/005).
//!
//! Everything an agent or CI needs without the Tauri app: `init` scaffolds a
//! project; `check`/`build`/`fmt`/`bundle`/`test` analyse and produce. The
//! MCP agent surface moved into the IDE (issue #33); the Lua Language Server
//! is its own binary, `lua-analyzer`, which agents and the IDE spawn directly.

mod bundle;
mod fmt;
mod test;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "dcs-studio-cli",
    version,
    about = "DCS Studio companion CLI: project scaffolding, checking, building, formatting, testing, bundling, and install deploys"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
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
    /// A nonexistent root is an error, never a clean workspace.
    Check {
        /// Workspace root to analyse.
        #[arg(default_value = ".")]
        root: PathBuf,
    },
    /// Format .lua files in place (house style, decisions/006); a
    /// directory walks like `check`. Unparseable files are reported and
    /// skipped — parse errors are `check`'s job. An internal guard trip
    /// leaves the file unchanged and the walk continues, but the run
    /// exits nonzero in both modes — a trip is a formatter bug leaving
    /// a file non-canonical, and a gate built on fmt must go red.
    Fmt {
        /// Files or directories to format.
        #[arg(default_value = ".")]
        paths: Vec<PathBuf>,
        /// Write nothing; list files that would change and exit 1 if any.
        #[arg(long)]
        check: bool,
    },
    /// Build the project: `cargo build --release` for Rust projects,
    /// a no-op for everything else.
    Build {
        /// Project root.
        #[arg(default_value = ".")]
        root: PathBuf,
    },
    /// Run the project's Lua unit tests outside DCS (issue #9): specs
    /// from the manifest's [test] table (default tests/**/*.test.lua)
    /// execute in the external dcs-lua-runner, each file in a fresh
    /// Lua 5.1 state with the DCS stub environment. Any failing test —
    /// or a missing runner — exits nonzero.
    Test {
        /// Project root.
        #[arg(default_value = ".")]
        root: PathBuf,
        /// Output format; `junit` also writes XML to --junit-out.
        #[arg(long, value_enum, default_value = "pretty")]
        reporter: test::Reporter,
        /// Where `--reporter junit` writes its XML.
        #[arg(long, default_value = "junit.xml")]
        junit_out: PathBuf,
    },
    /// Bundle a lua-script project into one dist/ file (issue #9):
    /// the require graph from the manifest's [build] entry becomes
    /// package.preload entries plus the entry body — require semantics
    /// preserved, DCS-provided modules left untouched.
    Bundle {
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
    // Logs to stderr (stdout is reserved for command output); quiet by
    // default, raise with `DCS_LOG=debug`.
    dcs_studio_project::logging::init("warn");
    match Cli::parse().command {
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
            // A root that does not exist (or is not a directory) is an
            // error, never a clean workspace — analysing nothing must not
            // exit 0 (model: `studio::cli::Cli.Check`). An empty-but-
            // existing dir stays clean: a blank project has no findings.
            if !root.is_dir() {
                eprintln!("check: '{}' does not exist", root.display());
                return ExitCode::FAILURE;
            }
            let report = studio_mcp::check::run(&root);
            print!("{}", report.rendered);
            // Exit codes above 100 are reserved for runner failures.
            ExitCode::from(u8::try_from(report.error_count.min(100)).unwrap_or(100))
        }
        Command::Fmt { paths, check } => fmt::run(&paths, check),
        Command::Test {
            root,
            reporter,
            junit_out,
        } => test::run(&root, reporter, &junit_out),
        Command::Bundle { root } => bundle::run(&root),
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
