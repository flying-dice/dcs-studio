//! The mock signing server's request handler — pure (no socket) so the crypto
//! is unit-testable in CI. Mints an ed25519 key per user (in memory, never
//! shared), signs a manifest's canonical bytes, and validates a signature
//! against the (non-revoked) signer's key.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use base64::Engine;
use ed25519_dalek::{Signature as EdSignature, Signer, SigningKey, Verifier};
use serde::Deserialize;

use studio_packages::{PackageManifest, Signature, Validity};

/// In-memory keystore + revocation set. One server instance per session.
#[derive(Default)]
pub struct State {
    keys: Mutex<HashMap<String, SigningKey>>,
    revoked: Mutex<HashSet<String>>,
}

impl State {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The user's signing key, minted on first use.
    fn key_for(&self, user: &str) -> SigningKey {
        let mut keys = self.keys.lock().expect("keys lock");
        keys.entry(user.to_string())
            .or_insert_with(|| SigningKey::generate(&mut rand::rngs::OsRng))
            .clone()
    }

    fn verifying_key(&self, user: &str) -> Option<ed25519_dalek::VerifyingKey> {
        self.keys
            .lock()
            .expect("keys lock")
            .get(user)
            .map(SigningKey::verifying_key)
    }

    fn is_revoked(&self, user: &str) -> bool {
        self.revoked.lock().expect("revoked lock").contains(user)
    }

    /// Revoke a user — every signature with this `key_id` now validates false.
    pub fn revoke(&self, user: &str) {
        self.revoked
            .lock()
            .expect("revoked lock")
            .insert(user.to_string());
    }
}

#[derive(Deserialize)]
struct SignRequest {
    user: String,
    token: String,
    manifest: PackageManifest,
}

#[derive(Deserialize)]
struct VerifyRequest {
    manifest: PackageManifest,
    signature: Signature,
}

#[derive(Deserialize)]
struct RevokeRequest {
    user: String,
}

/// Handle one request. Returns `(status, json-body)`.
#[must_use]
pub fn handle(path: &str, body: &[u8], state: &State) -> (u16, String) {
    match path {
        "/sign" => sign(body, state),
        "/verify" => verify(body, state),
        "/revoke" => revoke(body, state),
        _ => (404, json_err("no such endpoint")),
    }
}

fn sign(body: &[u8], state: &State) -> (u16, String) {
    let Ok(req) = serde_json::from_slice::<SignRequest>(body) else {
        return (400, json_err("malformed sign request"));
    };
    // The mock authenticates on any non-empty token (a real server checks the
    // GitHub session). An empty token is a logged-out caller.
    if req.token.trim().is_empty() {
        return (401, json_err("not authenticated"));
    }
    let key = state.key_for(&req.user);
    let sig = key.sign(&req.manifest.canonical_bytes());
    let signature = Signature {
        value: base64::engine::general_purpose::STANDARD.encode(sig.to_bytes()),
        key_id: req.user,
        signed_at: "2026-01-01T00:00:00Z".to_string(),
    };
    (
        200,
        serde_json::to_string(&signature).expect("serialise signature"),
    )
}

fn verify(body: &[u8], state: &State) -> (u16, String) {
    let Ok(req) = serde_json::from_slice::<VerifyRequest>(body) else {
        return (400, json_err("malformed verify request"));
    };
    let verdict = validate(&req, state);
    (
        200,
        serde_json::to_string(&verdict).expect("serialise validity"),
    )
}

fn validate(req: &VerifyRequest, state: &State) -> Validity {
    let invalid = |reason: &str| Validity {
        valid: false,
        reason: reason.to_string(),
    };
    if state.is_revoked(&req.signature.key_id) {
        return invalid("author revoked");
    }
    let Some(vk) = state.verifying_key(&req.signature.key_id) else {
        return invalid("unknown signer");
    };
    let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(&req.signature.value) else {
        return invalid("malformed signature");
    };
    let Ok(bytes): Result<[u8; 64], _> = raw.try_into() else {
        return invalid("malformed signature");
    };
    let sig = EdSignature::from_bytes(&bytes);
    match vk.verify(&req.manifest.canonical_bytes(), &sig) {
        Ok(()) => Validity {
            valid: true,
            reason: "ok".to_string(),
        },
        Err(_) => invalid("signature does not verify"),
    }
}

fn revoke(body: &[u8], state: &State) -> (u16, String) {
    let Ok(req) = serde_json::from_slice::<RevokeRequest>(body) else {
        return (400, json_err("malformed revoke request"));
    };
    state.revoke(&req.user);
    (200, "{\"revoked\":true}".to_string())
}

fn json_err(message: &str) -> String {
    serde_json::json!({ "error": message }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(hash: &str) -> PackageManifest {
        PackageManifest {
            name: "demo".into(),
            version: "1.0.0".into(),
            author: "alice".into(),
            created_at: "0".into(),
            content_hash: hash.into(),
            rules: vec![],
        }
    }

    fn sign_ok(state: &State, user: &str, m: &PackageManifest) -> Signature {
        let body = serde_json::json!({ "user": user, "token": "t", "manifest": m });
        let (code, out) = handle("/sign", body.to_string().as_bytes(), state);
        assert_eq!(code, 200, "{out}");
        serde_json::from_str(&out).unwrap()
    }

    fn verify(state: &State, m: &PackageManifest, sig: &Signature) -> Validity {
        let body = serde_json::json!({ "manifest": m, "signature": sig });
        let (code, out) = handle("/verify", body.to_string().as_bytes(), state);
        assert_eq!(code, 200);
        serde_json::from_str(&out).unwrap()
    }

    #[test]
    fn sign_then_verify_round_trips() {
        let state = State::new();
        let m = manifest("aaaa");
        let sig = sign_ok(&state, "alice", &m);
        assert!(verify(&state, &m, &sig).valid);
    }

    #[test]
    fn a_tampered_manifest_does_not_verify() {
        let state = State::new();
        let sig = sign_ok(&state, "alice", &manifest("aaaa"));
        // Same signer, different content hash → signature must fail.
        assert!(!verify(&state, &manifest("bbbb"), &sig).valid);
    }

    #[test]
    fn revoked_author_no_longer_verifies() {
        let state = State::new();
        let m = manifest("aaaa");
        let sig = sign_ok(&state, "alice", &m);
        assert!(verify(&state, &m, &sig).valid);
        let (code, _) = handle("/revoke", br#"{"user":"alice"}"#, &state);
        assert_eq!(code, 200);
        let v = verify(&state, &m, &sig);
        assert!(!v.valid);
        assert!(v.reason.contains("revoked"), "{}", v.reason);
    }

    #[test]
    fn an_empty_token_is_unauthenticated() {
        let state = State::new();
        let body = serde_json::json!({ "user": "alice", "token": "", "manifest": manifest("a") });
        let (code, _) = handle("/sign", body.to_string().as_bytes(), &state);
        assert_eq!(code, 401);
    }
}
