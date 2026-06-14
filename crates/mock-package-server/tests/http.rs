//! End-to-end over real HTTP + real ed25519: spawn the mock server binary, then
//! drive `studio_packages::HttpSigningClient` against it — sign a manifest,
//! validate it, revoke the author, and confirm validation now fails. This is the
//! external oracle for the HTTP signing path (the in-process `MockSigningClient`
//! covers the flow; this proves the wire + crypto).

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};

use studio_packages::{HttpSigningClient, Identity, PackageManifest, SigningClient};

/// Spawn the server on an ephemeral port; return (child, base_url).
fn spawn() -> (Child, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_mock-package-server"))
        .arg("0")
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn mock-package-server");
    let mut line = String::new();
    BufReader::new(child.stdout.take().expect("stdout"))
        .read_line(&mut line)
        .expect("read address line");
    let base = line
        .trim()
        .strip_prefix("listening ")
        .expect("address line")
        .to_string();
    (child, base)
}

fn manifest(hash: &str) -> PackageManifest {
    PackageManifest {
        name: "Demo".into(),
        version: "1.0.0".into(),
        author: "alice".into(),
        created_at: "0".into(),
        content_hash: hash.into(),
        rules: vec![],
    }
}

#[test]
fn http_sign_validate_revoke() {
    let (mut child, base) = spawn();
    let client = HttpSigningClient::new(&base, "tok");
    let me = Identity {
        login: "alice".into(),
    };
    let m = manifest("aaaa");

    let sig = client.sign(&me, &m).expect("sign");
    assert!(client.validate(&m, &sig).expect("validate").valid);

    // A different manifest under the same signature does not verify.
    assert!(
        !client
            .validate(&manifest("bbbb"), &sig)
            .expect("validate2")
            .valid
    );

    // Revoke the author on the server, then validation of the SAME package fails.
    ureq::post(&format!("{base}/revoke"))
        .send_json(serde_json::json!({ "user": "alice" }))
        .expect("revoke");
    let after = client.validate(&m, &sig).expect("validate3");
    assert!(!after.valid);
    assert!(after.reason.contains("revoked"), "{}", after.reason);

    let _ = child.kill();
}
