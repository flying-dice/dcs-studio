//! The package manifest — the signed description of a package (model
//! `studio::package::PackageManifest`). The signature covers this manifest's
//! canonical bytes, and `content_hash` covers the payload tree, so the signature
//! transitively binds every payload byte.

use serde::{Deserialize, Serialize};

/// One `[[install]]` rule carried in the package (a serialisable mirror of
/// `dcs_studio_project::InstallRule`): a project-relative `source` and a
/// root-anchored `dest`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Rule {
    pub source: String,
    pub dest: String,
}

/// The signed package description.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PackageManifest {
    pub name: String,
    pub version: String,
    /// The signing author's identity (login) — the revocation key.
    pub author: String,
    pub created_at: String,
    /// SHA-256 over the sorted payload tree (`crate::hash`).
    pub content_hash: String,
    pub rules: Vec<Rule>,
}

impl PackageManifest {
    /// The canonical bytes the signature is computed over. `serde_json` emits a
    /// struct's fields in declaration order and `rules` is an ordered `Vec`, so
    /// this is stable — the client and server derive identical bytes from the
    /// same manifest, which is all that signing/verification requires.
    #[must_use]
    // Infallible serialise (String/Vec fields only); fail loud on the impossible
    // rather than a fallback — empty/default bytes would corrupt the signature.
    #[allow(clippy::expect_used)]
    pub fn canonical_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("PackageManifest has no non-serialisable fields")
    }
}
