//! Discover, install, uninstall, and revalidate packages (model
//! `PackageLibrary`).
//!
//! Install is the revocation gate: the payload hash is checked against the
//! signed manifest (tamper), then the signature is validated by the server
//! (authentic AND author not revoked) BEFORE anything is linked. The payload
//! lands in a content store; each rule's destination links into it; a ledger
//! records what was placed so uninstall is exact.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use dcs_studio_project::install::{resolve_dest, stays_under};
use dcs_studio_project::RootMap;

use crate::build::package_id;
use crate::linkfs::{self, PlacedLink};
use crate::manifest::PackageManifest;
use crate::signing::SigningClient;

const MANIFEST_FILE: &str = "package.json";
const SIGNATURE_FILE: &str = "signature.json";
const LEDGER_FILE: &str = "ledger.json";
const FILES_DIR: &str = "files";

/// A discovered `.dcspkg` in the watch folder.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PackageEntry {
    pub id: String,
    pub name: String,
    pub author: String,
    pub signed_at: String,
    pub path: String,
}

/// What an install run linked into the roots.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PackageInstallReport {
    pub linked: usize,
    pub files: Vec<String>,
}

/// An installed package whose author has since been revoked.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct StalePackage {
    pub id: String,
    pub author: String,
}

#[derive(Serialize, Deserialize)]
struct Ledger {
    id: String,
    author: String,
    links: Vec<PlacedLink>,
}

/// Every `.dcspkg` in `folder`, header read only (no payload extraction). An
/// unreadable artifact is skipped, not fatal.
#[must_use]
pub fn discover(folder: &Path) -> Vec<PackageEntry> {
    let Ok(read) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut out: Vec<PackageEntry> = read
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("dcspkg"))
        })
        .filter_map(|path| {
            let (manifest, signature) = crate::archive::read_header(&path).ok()?;
            Some(PackageEntry {
                id: package_id(&manifest.name, &manifest.content_hash),
                name: manifest.name,
                author: manifest.author,
                signed_at: signature.signed_at,
                path: path.to_string_lossy().into_owned(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Read the header of one `.dcspkg` and build its [`PackageEntry`] (for
/// installing a specific artifact by path).
///
/// # Errors
/// Returns `Err` when the artifact is not a readable `.dcspkg`.
pub fn entry_for(artifact: &Path) -> Result<PackageEntry, String> {
    let (manifest, signature) = crate::archive::read_header(artifact)?;
    Ok(PackageEntry {
        id: package_id(&manifest.name, &manifest.content_hash),
        name: manifest.name,
        author: manifest.author,
        signed_at: signature.signed_at,
        path: artifact.to_string_lossy().into_owned(),
    })
}

/// Install the package at `entry.path`: hash-check, server-validate, then link
/// the payload into the roots from `store_dir`.
///
/// # Errors
/// Returns `Err` when the artifact is unreadable, the payload was tampered (hash
/// mismatch), the server rejects the signature (invalid or author revoked), a
/// rule escapes its root, or a link cannot be placed.
pub fn install(
    entry: &PackageEntry,
    roots: &RootMap,
    store_dir: &Path,
    signer: &dyn SigningClient,
) -> Result<PackageInstallReport, String> {
    let artifact = Path::new(&entry.path);
    let (manifest, signature) = crate::archive::read_header(artifact)?;
    let id = package_id(&manifest.name, &manifest.content_hash);

    // Stage the payload and verify it matches the signed manifest BEFORE trust.
    let staging = store_dir.join(format!("{id}.staging"));
    let _ = std::fs::remove_dir_all(&staging);
    crate::archive::extract_payload(artifact, &staging)?;
    let recomputed = crate::hash::content_hash(&staging).inspect_err(|_| rm(&staging))?;
    if recomputed != manifest.content_hash {
        rm(&staging);
        return Err("package payload does not match its signed manifest (tampered)".into());
    }

    // The server is the gate: authentic AND author not revoked.
    let validity = signer
        .validate(&manifest, &signature)
        .inspect_err(|_| rm(&staging))?;
    if !validity.valid {
        rm(&staging);
        return Err(format!(
            "package rejected by the signing server: {}",
            validity.reason
        ));
    }

    // Commit: move the payload into the store, then link each rule's dest in.
    // Replace any prior install of this exact package CLEANLY first — drop its
    // ledgered links, not just the store dir — so a re-install never collides
    // with its own surviving destinations (and never strands dangling links).
    let store = store_dir.join(&id);
    if store.exists() {
        let _ = uninstall(&id, store_dir);
    }
    let files_dir = store.join(FILES_DIR);
    move_dir(&staging, &files_dir).inspect_err(|_| {
        rm(&staging);
        rm(&store);
    })?;
    persist_header(&store, &manifest, &signature).inspect_err(|_| rm(&store))?;

    match place_all(&manifest, roots, &files_dir) {
        Ok(placed) => {
            let report = PackageInstallReport {
                linked: placed.len(),
                files: placed.iter().map(|p| p.path.clone()).collect(),
            };
            write_ledger(
                &store,
                &Ledger {
                    id,
                    author: manifest.author,
                    links: placed,
                },
            )
            .inspect_err(|_| rm(&store))?;
            Ok(report)
        }
        Err((placed, err)) => {
            // Roll back every link placed so far, then drop the store.
            for link in &placed {
                let _ = linkfs::remove(Path::new(&link.path));
            }
            rm(&store);
            Err(err)
        }
    }
}

/// Link every rule's destination into `files_dir`. On failure returns the links
/// placed so far (for rollback) plus the error.
fn place_all(
    manifest: &PackageManifest,
    roots: &RootMap,
    files_dir: &Path,
) -> Result<Vec<PlacedLink>, (Vec<PlacedLink>, String)> {
    let mut placed: Vec<PlacedLink> = Vec::new();
    for rule in &manifest.rules {
        if !stays_under(&rule.source) {
            return Err((
                placed,
                format!("rule source '{}' escapes the root", rule.source),
            ));
        }
        let dest_dir = match resolve_dest(&rule.dest, roots) {
            Ok(d) => d,
            Err(e) => return Err((placed, e)),
        };
        let src = files_dir.join(&rule.source);
        let targets: Vec<(PathBuf, PathBuf)> = if src.is_dir() {
            match crate::fsutil::walk(&src) {
                Ok(files) => files
                    .into_iter()
                    .map(|(rel, path)| (path, dest_dir.join(&rel)))
                    .collect(),
                Err(e) => return Err((placed, e)),
            }
        } else {
            match src.file_name() {
                Some(name) => vec![(src.clone(), dest_dir.join(name))],
                None => return Err((placed, format!("rule source '{}' has no name", rule.source))),
            }
        };
        for (target, dest) in targets {
            match linkfs::place_file(&target, &dest) {
                Ok(mode) => placed.push(PlacedLink {
                    path: dest.to_string_lossy().into_owned(),
                    mode,
                }),
                Err(e) => return Err((placed, e)),
            }
        }
    }
    Ok(placed)
}

/// Remove an installed package: unlink everything its ledger recorded, then drop
/// the content store.
///
/// # Errors
/// Returns `Err` when the ledger is unreadable or a link cannot be removed.
pub fn uninstall(id: &str, store_dir: &Path) -> Result<(), String> {
    let store = store_dir.join(id);
    if !store.exists() {
        return Ok(());
    }
    let ledger = read_ledger(&store)?;
    for link in ledger.links {
        linkfs::remove(Path::new(&link.path))?;
    }
    std::fs::remove_dir_all(&store).map_err(|e| format!("removing {}: {e}", store.display()))
}

/// Every installed package in the content store (one per subdir holding a
/// persisted manifest). Unreadable stores are skipped.
#[must_use]
pub fn installed_packages(store_dir: &Path) -> Vec<PackageEntry> {
    let Ok(read) = std::fs::read_dir(store_dir) else {
        return Vec::new();
    };
    let mut out: Vec<PackageEntry> = read
        .filter_map(Result::ok)
        .filter_map(|e| {
            let store = e.path();
            let (manifest, signature) = read_header(&store).ok()?;
            Some(PackageEntry {
                id: package_id(&manifest.name, &manifest.content_hash),
                name: manifest.name,
                author: manifest.author,
                signed_at: signature.signed_at,
                path: store.to_string_lossy().into_owned(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Re-validate every installed package against the signing server; report those
/// the server now rejects (author revoked). Transport errors are skipped (a
/// package isn't declared stale just because the server is briefly unreachable).
///
/// # Errors
/// Returns `Err` only when the store directory itself cannot be read.
pub fn revalidate_installed(
    store_dir: &Path,
    signer: &dyn SigningClient,
) -> Result<Vec<StalePackage>, String> {
    let mut stale = Vec::new();
    let read = match std::fs::read_dir(store_dir) {
        Ok(r) => r,
        Err(_) => return Ok(stale), // no store yet → nothing installed
    };
    for entry in read.filter_map(Result::ok) {
        let store = entry.path();
        if !store.join(MANIFEST_FILE).exists() {
            continue;
        }
        let Ok((manifest, signature)) = read_header(&store) else {
            continue;
        };
        match signer.validate(&manifest, &signature) {
            Ok(v) if !v.valid => stale.push(StalePackage {
                id: package_id(&manifest.name, &manifest.content_hash),
                author: manifest.author,
            }),
            _ => {}
        }
    }
    Ok(stale)
}

// ---- store helpers ---------------------------------------------------------

fn persist_header(
    store: &Path,
    manifest: &PackageManifest,
    signature: &crate::signing::Signature,
) -> Result<(), String> {
    write_json(&store.join(MANIFEST_FILE), manifest)?;
    write_json(&store.join(SIGNATURE_FILE), signature)
}

fn read_header(store: &Path) -> Result<(PackageManifest, crate::signing::Signature), String> {
    Ok((
        read_json(&store.join(MANIFEST_FILE))?,
        read_json(&store.join(SIGNATURE_FILE))?,
    ))
}

fn write_ledger(store: &Path, ledger: &Ledger) -> Result<(), String> {
    write_json(&store.join(LEDGER_FILE), ledger)
}

fn read_ledger(store: &Path) -> Result<Ledger, String> {
    read_json(&store.join(LEDGER_FILE))
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("creating {}: {e}", parent.display()))?;
    }
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| format!("serialising: {e}"))?;
    std::fs::write(path, bytes).map_err(|e| format!("writing {}: {e}", path.display()))
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("parsing {}: {e}", path.display()))
}

/// Move a directory, falling back to copy+remove across devices.
fn move_dir(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("creating {}: {e}", parent.display()))?;
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    crate::fsutil::copy_tree_or_file(from, to)?;
    let _ = std::fs::remove_dir_all(from);
    Ok(())
}

fn rm(path: &Path) {
    let _ = std::fs::remove_dir_all(path);
}
