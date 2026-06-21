//! The `lua-cargo` CLI (model `studio::cargolua`).
//!
//! ```text
//! lua-cargo build  [--manifest-path <CargoLua.toml>]   # resolve, then bundle
//! lua-cargo fetch  [--manifest-path <CargoLua.toml>]   # resolve only
//! lua-cargo bundle [--manifest-path <CargoLua.toml>]   # bundle only
//! ```
//!
//! `--manifest-path` points at a `CargoLua.toml`; its parent directory is the
//! project root. Defaults to `./CargoLua.toml`. The report goes to stdout; any
//! error goes to stderr and exits non-zero.

// A CLI's job is to print its report and errors — stdout/stderr writes here are
// the intended output surface, not stray debugging.
#![allow(clippy::print_stdout, clippy::print_stderr)]

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use lua_cargo::{BundleReport, CargoError, ResolveReport, bundle, manifest, resolve};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(Cli::Usage(msg)) => {
            eprintln!("{msg}\n\n{USAGE}");
            ExitCode::from(2)
        }
        Err(Cli::Failed(err)) => {
            eprintln!("error: {err}");
            ExitCode::FAILURE
        }
    }
}

const USAGE: &str = "\
usage: lua-cargo <build|fetch|bundle> [--manifest-path <CargoLua.toml>]

  build    resolve dependencies, then bundle every [[bundle]] target
  fetch    resolve (vendor + lock) dependencies only
  bundle   amalgamate the require graph only";

/// A CLI failure: a usage problem (exit 2) or a toolchain error (exit 1).
enum Cli {
    Usage(String),
    Failed(CargoError),
}

impl From<CargoError> for Cli {
    fn from(e: CargoError) -> Self {
        Cli::Failed(e)
    }
}

fn run(args: &[String]) -> Result<(), Cli> {
    let mut iter = args.iter();
    let command = iter
        .next()
        .ok_or_else(|| Cli::Usage("missing subcommand".into()))?;

    let mut manifest_path: Option<PathBuf> = None;
    while let Some(flag) = iter.next() {
        match flag.as_str() {
            "--manifest-path" => {
                let value = iter
                    .next()
                    .ok_or_else(|| Cli::Usage("--manifest-path needs a value".into()))?;
                manifest_path = Some(PathBuf::from(value));
            }
            other => return Err(Cli::Usage(format!("unknown argument: {other}"))),
        }
    }

    let root = root_from_manifest(manifest_path.as_deref())?;

    match command.as_str() {
        "fetch" => {
            let report = resolve(&root)?;
            print_resolve(&report);
        }
        "bundle" => {
            let report = bundle(&root)?;
            print_bundle(&report);
        }
        "build" => {
            let resolved = resolve(&root)?;
            print_resolve(&resolved);
            let bundled = bundle(&root)?;
            print_bundle(&bundled);
        }
        other => return Err(Cli::Usage(format!("unknown subcommand: {other}"))),
    }
    Ok(())
}

/// The project root for an optional `--manifest-path`. A path to a file uses its
/// parent; a path to a directory is the root; absent defaults to the cwd.
fn root_from_manifest(manifest_path: Option<&Path>) -> Result<PathBuf, Cli> {
    match manifest_path {
        Some(path) if path.is_dir() => Ok(path.to_path_buf()),
        Some(path) => Ok(path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."))),
        None => {
            let cwd = std::env::current_dir()
                .map_err(|e| Cli::Failed(CargoError::Io(format!("cwd: {e}"))))?;
            let candidate = cwd.join(manifest::MANIFEST_FILE);
            if !candidate.is_file() {
                return Err(Cli::Failed(CargoError::Manifest(format!(
                    "no {} in {}",
                    manifest::MANIFEST_FILE,
                    cwd.display()
                ))));
            }
            Ok(cwd)
        }
    }
}

fn print_resolve(report: &ResolveReport) {
    println!("resolved {} dependencies:", report.entries.len());
    for entry in &report.entries {
        let short = entry.rev.get(..7).unwrap_or(&entry.rev);
        println!("  {} ({}) @ {}", entry.name, entry.github, short);
    }
    println!("  vendor dir: {}", report.vendor_dir.display());
}

fn print_bundle(report: &BundleReport) {
    println!(
        "bundled {} modules -> {}",
        report.modules.len(),
        report.output.display()
    );
    if !report.warnings.is_empty() {
        println!("  {} unresolved (host-provided):", report.warnings.len());
        for w in &report.warnings {
            println!("    - {w}");
        }
    }
}
