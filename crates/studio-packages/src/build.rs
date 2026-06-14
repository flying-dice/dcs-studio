//! Building a `.dcspkg` from the open project (model `Packager.BuildPackage`).

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::identity::{Identity, IdentityProvider};
use crate::manifest::{PackageManifest, Rule};
use crate::signing::SigningClient;

/// Package the project at `root`, gated on a logged-in identity (model
/// `Packager.BuildPackage`: signing is only available to an identified author).
/// Resolves the current identity from `idp` and refuses when nobody is signed
/// in, then delegates to [`build_package`].
///
/// # Errors
/// Returns `Err` when no identity is available, or for any [`build_package`]
/// failure.
pub fn build_package_with(
    root: &Path,
    out_dir: &Path,
    idp: &dyn IdentityProvider,
    signer: &dyn SigningClient,
) -> Result<PathBuf, String> {
    let identity = idp
        .current()
        .ok_or_else(|| "not signed in — sign in to package and ship a mod".to_string())?;
    build_package(root, out_dir, &identity, signer)
}

/// Bundle the project at `root` into a signed `.dcspkg` under `out_dir`.
///
/// Gathers each `[[install]]` rule's source (escape-guarded, same as the project
/// installer) into a staging tree, hashes it, asks `signer` to sign the
/// manifest, and writes the artifact. Returns its path.
///
/// # Errors
/// Returns `Err` when the manifest declares no rules, a source escapes the root
/// or is missing, hashing fails, or signing/writing fails. The caller is
/// responsible for having an identity — signing is gated on login upstream.
pub fn build_package(
    root: &Path,
    out_dir: &Path,
    identity: &Identity,
    signer: &dyn SigningClient,
) -> Result<PathBuf, String> {
    let manifest = dcs_studio_project::manifest::load(root)?;
    if manifest.install.is_empty() {
        return Err("dcs-studio.toml declares no [[install]] rules — nothing to package".into());
    }

    let staging = out_dir.join(".dcspkg-staging");
    let _ = std::fs::remove_dir_all(&staging);
    for rule in &manifest.install {
        if !dcs_studio_project::install::stays_under(&rule.source) {
            cleanup(&staging);
            return Err(format!(
                "install rule source '{}' escapes the project root",
                rule.source
            ));
        }
        let src = root.join(rule.source.trim_end_matches(['/', '\\']));
        if !src.exists() {
            cleanup(&staging);
            return Err(format!("install rule source '{}' not found", rule.source));
        }
        if let Err(e) = crate::fsutil::copy_tree_or_file(&src, &staging.join(&rule.source)) {
            cleanup(&staging);
            return Err(e);
        }
    }

    let content_hash = match crate::hash::content_hash(&staging) {
        Ok(h) => h,
        Err(e) => {
            cleanup(&staging);
            return Err(e);
        }
    };
    let version = if manifest.project.version.is_empty() {
        "0.0.0".to_string()
    } else {
        manifest.project.version.clone()
    };
    let pkg = PackageManifest {
        name: manifest.project.name.clone(),
        version,
        author: identity.login.clone(),
        created_at: now_rfc3339(),
        content_hash,
        rules: manifest
            .install
            .iter()
            .map(|r| Rule {
                source: r.source.clone(),
                dest: r.dest.clone(),
            })
            .collect(),
    };

    let signature = match signer.sign(identity, &pkg) {
        Ok(s) => s,
        Err(e) => {
            cleanup(&staging);
            return Err(e);
        }
    };

    let id = package_id(&pkg.name, &pkg.content_hash);
    let out_path = out_dir.join(format!("{id}.dcspkg"));
    let write = crate::archive::write(&out_path, &pkg, &signature, &staging);
    cleanup(&staging);
    write?;
    Ok(out_path)
}

/// A stable, filesystem-safe id: `<name-slug>-<hash-prefix>`.
#[must_use]
pub fn package_id(name: &str, content_hash: &str) -> String {
    let slug: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let slug = slug.trim_matches('-');
    // The FULL content hash (not a 12-hex prefix): the id keys the content
    // store, and install drops a colliding store entry before placing — a
    // short prefix lets a crafted package force-uninstall a victim's links.
    format!("{slug}-{content_hash}")
}

fn now_rfc3339() -> String {
    // A coarse UTC stamp without pulling in chrono: seconds since the epoch as a
    // string. The signature covers it, so the exact format only needs to be
    // stable per build (it is) — humans see it in the panel, machines compare
    // the whole manifest.
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn cleanup(staging: &Path) {
    let _ = std::fs::remove_dir_all(staging);
}
