//! studio-packages — build, discover, install, and revalidate signed mod
//! packages (model `studio::package`, issue #37). Tauri-free; shared by the app
//! and the CLI.
//!
//! Keys never reach the client. The signing server signs the manifest at BUILD
//! time and validates it at INSTALL time — so revoking an author makes every
//! package they signed uninstallable no matter who reshared it. This crate only
//! ferries the manifest + signature and hashes the payload (`content_hash`),
//! which the signature transitively binds.

pub mod archive;
pub mod build;
pub mod hash;
pub mod identity;
pub mod install;
pub mod linkfs;
pub mod manifest;
pub mod signing;

mod fsutil;

pub use build::{build_package, build_package_with};
pub use identity::{Identity, IdentityProvider, StaticIdentity};
pub use install::{
    discover, entry_for, install, installed_packages, revalidate_installed, uninstall,
    PackageEntry, PackageInstallReport, StalePackage,
};
pub use manifest::{PackageManifest, Rule};
pub use signing::{HttpSigningClient, MockSigningClient, Signature, SigningClient, Validity};
