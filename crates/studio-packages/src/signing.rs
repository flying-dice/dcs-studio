//! The signing-server seam (model `studio::package::SigningService`).
//!
//! Keys stay server-side. [`SigningClient`] is the client's view: `sign` (build
//! time) and `validate` (install time). [`HttpSigningClient`] talks to the real
//! (or mock) server over HTTP; [`MockSigningClient`] is an in-process stand-in
//! for hermetic unit tests — a deterministic pseudo-signature plus a revocation
//! set (NOT real crypto; the mock SERVER does ed25519 and is tested over HTTP).

use std::collections::HashSet;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::identity::Identity;
use crate::manifest::PackageManifest;

/// A server-issued signature over a manifest. `key_id` names the author's
/// server-side key (the revocation handle); the client never sees the key.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Signature {
    pub value: String,
    pub key_id: String,
    pub signed_at: String,
}

/// The server's install-time verdict.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Validity {
    pub valid: bool,
    pub reason: String,
}

/// The client's view of the signing server.
pub trait SigningClient {
    /// Sign `manifest` for `identity` (build time).
    ///
    /// # Errors
    /// Returns `Err` on transport failure or a server rejection.
    fn sign(&self, identity: &Identity, manifest: &PackageManifest) -> Result<Signature, String>;

    /// Validate a `manifest` + `signature` (install time): authentic AND author
    /// not revoked. A revoked/invalid author is `Ok(Validity { valid: false })`,
    /// not an `Err`.
    ///
    /// # Errors
    /// Returns `Err` only on transport failure.
    fn validate(
        &self,
        manifest: &PackageManifest,
        signature: &Signature,
    ) -> Result<Validity, String>;
}

/// HTTP client to the signing server (`POST /sign`, `POST /verify`).
pub struct HttpSigningClient {
    base_url: String,
    token: String,
}

impl HttpSigningClient {
    /// `base_url` like `http://127.0.0.1:8787`; `token` authenticates the user
    /// to the server (the GitHub session token once #11 lands).
    pub fn new(base_url: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            token: token.into(),
        }
    }
}

impl SigningClient for HttpSigningClient {
    fn sign(&self, identity: &Identity, manifest: &PackageManifest) -> Result<Signature, String> {
        let body = serde_json::json!({
            "user": identity.login,
            "token": self.token,
            "manifest": manifest,
        });
        ureq::post(&format!("{}/sign", self.base_url))
            .send_json(body)
            .map_err(|e| format!("sign request failed: {e}"))?
            .into_json::<Signature>()
            .map_err(|e| format!("sign response: {e}"))
    }

    fn validate(
        &self,
        manifest: &PackageManifest,
        signature: &Signature,
    ) -> Result<Validity, String> {
        let body = serde_json::json!({ "manifest": manifest, "signature": signature });
        ureq::post(&format!("{}/verify", self.base_url))
            .send_json(body)
            .map_err(|e| format!("verify request failed: {e}"))?
            .into_json::<Validity>()
            .map_err(|e| format!("verify response: {e}"))
    }
}

/// In-process signer for hermetic unit tests — a deterministic pseudo-signature
/// (`sha256(canonical_manifest || user)`) plus a revocation set. NOT real
/// crypto: the mock SERVER (`mock-package-server`) does ed25519 and is exercised
/// over HTTP via [`HttpSigningClient`]. Enough to drive sign → validate → revoke.
#[derive(Default)]
pub struct MockSigningClient {
    revoked: Mutex<HashSet<String>>,
}

impl MockSigningClient {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Revoke `user` — every signature with this `key_id` now validates false.
    pub fn revoke(&self, user: &str) {
        self.revoked
            .lock()
            .expect("revoked lock")
            .insert(user.to_string());
    }

    fn token(manifest: &PackageManifest, user: &str) -> String {
        let mut h = Sha256::new();
        h.update(manifest.canonical_bytes());
        h.update(b"\0");
        h.update(user.as_bytes());
        crate::hash::hex(&h.finalize())
    }
}

impl SigningClient for MockSigningClient {
    fn sign(&self, identity: &Identity, manifest: &PackageManifest) -> Result<Signature, String> {
        Ok(Signature {
            value: Self::token(manifest, &identity.login),
            key_id: identity.login.clone(),
            signed_at: "1970-01-01T00:00:00Z".to_string(),
        })
    }

    fn validate(
        &self,
        manifest: &PackageManifest,
        signature: &Signature,
    ) -> Result<Validity, String> {
        if self
            .revoked
            .lock()
            .expect("revoked lock")
            .contains(&signature.key_id)
        {
            return Ok(Validity {
                valid: false,
                reason: "author revoked".to_string(),
            });
        }
        let valid = Self::token(manifest, &signature.key_id) == signature.value;
        Ok(Validity {
            valid,
            reason: if valid { "ok" } else { "signature mismatch" }.to_string(),
        })
    }
}
