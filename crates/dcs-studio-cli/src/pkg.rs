//! `pack` + `pkg` subcommands (issue #37): build a signed `.dcspkg`, and
//! list/install/uninstall downloaded packages. The signing server signs at
//! pack time and validates at install time, so revocation is enforced live.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::Subcommand;
use dcs_studio_project::RootMap;
use studio_packages::{
    HttpSigningClient, StaticIdentity, build_package_with, discover, entry_for, install,
};

/// `pack` — build a signed package from the project's `[[install]]` rules.
pub fn pack(root: &Path, out: &Path, signing_url: &str, user: &str, token: &str) -> ExitCode {
    let signer = HttpSigningClient::new(signing_url, token);
    let idp = StaticIdentity::new(user);
    match build_package_with(root, out, &idp, &signer) {
        Ok(path) => {
            println!("packaged {}", path.display());
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("pack: {error}");
            ExitCode::FAILURE
        }
    }
}

/// `pkg <action>` — manage downloaded packages.
#[derive(Subcommand)]
pub enum PkgAction {
    /// List every `.dcspkg` discovered in a folder.
    List {
        /// Folder to scan.
        #[arg(default_value = ".")]
        folder: PathBuf,
    },
    /// Install a package: hash-check, server-validate, then link it in.
    Install {
        /// The `.dcspkg` artifact to install.
        artifact: PathBuf,
        /// Signing-server base URL (validation gate).
        #[arg(long, default_value = "http://127.0.0.1:8787")]
        signing_url: String,
        /// Auth token presented to the signing server.
        #[arg(long, default_value = "dev")]
        token: String,
        /// DCS "Saved Games" folder; auto-detected when omitted.
        #[arg(long)]
        saved_games: Option<PathBuf>,
        /// DCS game install directory, for `{GameInstall}` rules.
        #[arg(long)]
        game_install: Option<PathBuf>,
        /// Content store directory.
        #[arg(long, default_value = "packages-store")]
        store: PathBuf,
    },
    /// Uninstall a package by id (unlinks everything its ledger recorded).
    Uninstall {
        /// The package id (from `pkg list`).
        id: String,
        /// Content store directory.
        #[arg(long, default_value = "packages-store")]
        store: PathBuf,
    },
}

/// Dispatch a `pkg` action.
#[must_use]
pub fn run(action: PkgAction) -> ExitCode {
    match action {
        PkgAction::List { folder } => list(&folder),
        PkgAction::Install {
            artifact,
            signing_url,
            token,
            saved_games,
            game_install,
            store,
        } => install_one(
            &artifact,
            &signing_url,
            &token,
            saved_games,
            game_install,
            &store,
        ),
        PkgAction::Uninstall { id, store } => uninstall(&id, &store),
    }
}

fn list(folder: &Path) -> ExitCode {
    for entry in discover(folder) {
        println!(
            "{}  {}  by {}  (signed {})",
            entry.id, entry.name, entry.author, entry.signed_at
        );
    }
    ExitCode::SUCCESS
}

fn install_one(
    artifact: &Path,
    signing_url: &str,
    token: &str,
    saved_games: Option<PathBuf>,
    game_install: Option<PathBuf>,
    store: &Path,
) -> ExitCode {
    let Some(saved_games) = saved_games.or_else(dcs_studio_project::default_saved_games) else {
        eprintln!("pkg install: no DCS Saved Games folder found — pass --saved-games <path>");
        return ExitCode::FAILURE;
    };
    let entry = match entry_for(artifact) {
        Ok(entry) => entry,
        Err(error) => {
            eprintln!("pkg install: {error}");
            return ExitCode::FAILURE;
        }
    };
    let roots = RootMap {
        saved_games,
        game_install,
    };
    let signer = HttpSigningClient::new(signing_url, token);
    match install(&entry, &roots, store, &signer) {
        Ok(report) => {
            println!("installed {} ({} files linked)", entry.name, report.linked);
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("pkg install: {error}");
            ExitCode::FAILURE
        }
    }
}

fn uninstall(id: &str, store: &Path) -> ExitCode {
    match studio_packages::uninstall(id, store) {
        Ok(()) => {
            println!("uninstalled {id}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("pkg uninstall: {error}");
            ExitCode::FAILURE
        }
    }
}
