#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing, clippy::panic, clippy::print_stdout, clippy::print_stderr)] // integration test crate: test code, exempt from the production safety lints

//! End-to-end over the in-process `MockSigningClient` (model `studio::package`):
//! build → discover → install → links placed → uninstall, plus the three refusal
//! arms — tampered payload, revoked author, escaping rule.

use std::path::{Path, PathBuf};

use dcs_studio_project::RootMap;
use studio_packages::{
    build_package, build_package_with, discover, entry_for, install, revalidate_installed,
    uninstall, Identity, MockSigningClient, PackageManifest, Rule, Signature, SigningClient,
    StaticIdentity, Validity,
};

/// A signer that is always offline — every call is a transport error. Used to
/// prove revalidation fails CLOSED (unverified), not open.
struct OfflineSigner;
impl SigningClient for OfflineSigner {
    fn sign(&self, _: &Identity, _: &PackageManifest) -> Result<Signature, String> {
        Err("offline".into())
    }
    fn validate(&self, _: &PackageManifest, _: &Signature) -> Result<Validity, String> {
        Err("connection refused".into())
    }
}

fn temp(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("studio-packages-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

fn write(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
}

/// A project with one dir rule and one file rule.
fn fixture_project(root: &Path) {
    write(
        &root.join("dcs-studio.toml"),
        r#"
[project]
name = "Demo Mod"
version = "1.2.3"

[[install]]
source = "Scripts"
dest = "{SavedGames}/Scripts"

[[install]]
source = "mod.lua"
dest = "{SavedGames}/Mods"
"#,
    );
    write(&root.join("Scripts/a.lua"), "return 1\n");
    write(&root.join("Scripts/sub/b.lua"), "return 2\n");
    write(&root.join("mod.lua"), "print('mod')\n");
}

fn roots(saved: &Path) -> RootMap {
    RootMap {
        saved_games: saved.to_path_buf(),
        game_install: None,
    }
}

#[test]
fn build_install_uninstall_round_trip() {
    let base = temp("rt");
    let project = base.join("project");
    fixture_project(&project);
    let out = base.join("out");
    let saved = base.join("saved");
    let store = base.join("store");
    let signer = MockSigningClient::new();
    let me = Identity {
        login: "alice".into(),
    };

    let artifact = build_package(&project, &out, &me, &signer).expect("build");
    assert!(artifact.exists());

    let found = discover(&out);
    assert_eq!(found.len(), 1, "{found:?}");
    let entry = &found[0];
    assert_eq!(entry.name, "Demo Mod");
    assert_eq!(entry.author, "alice");

    let report = install(entry, &roots(&saved), &store, &signer).expect("install");
    // Two Script files + one mod file linked.
    assert_eq!(report.linked, 3, "{report:?}");
    assert_eq!(
        std::fs::read_to_string(saved.join("Scripts/a.lua")).unwrap(),
        "return 1\n"
    );
    assert_eq!(
        std::fs::read_to_string(saved.join("Scripts/sub/b.lua")).unwrap(),
        "return 2\n"
    );
    assert_eq!(
        std::fs::read_to_string(saved.join("Mods/mod.lua")).unwrap(),
        "print('mod')\n"
    );

    // Uninstall removes exactly what was placed.
    uninstall(&entry.id, &store).expect("uninstall");
    assert!(!saved.join("Scripts/a.lua").exists());
    assert!(!saved.join("Mods/mod.lua").exists());

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn a_tampered_payload_is_refused() {
    let base = temp("tamper");
    let project = base.join("project");
    fixture_project(&project);
    let out = base.join("out");
    let signer = MockSigningClient::new();
    let me = Identity {
        login: "alice".into(),
    };
    let artifact = build_package(&project, &out, &me, &signer).expect("build");

    // Forge a tampered artifact: keep the SIGNED manifest + signature but swap a
    // payload file, so the recomputed hash no longer matches.
    let (manifest, signature) = studio_packages::archive::read_header(&artifact).expect("header");
    let payload = base.join("payload");
    studio_packages::archive::extract_payload(&artifact, &payload).expect("extract");
    std::fs::write(payload.join("Scripts/a.lua"), "return 666\n").unwrap();
    let forged = out.join("forged.dcspkg");
    studio_packages::archive::write(&forged, &manifest, &signature, &payload).expect("rezip");

    let saved = base.join("saved");
    let store = base.join("store");
    let entry = discover(&out)
        .into_iter()
        .find(|e| e.path.ends_with("forged.dcspkg"))
        .expect("forged entry");
    let err = install(&entry, &roots(&saved), &store, &signer).expect_err("must refuse tamper");
    assert!(err.contains("tampered"), "{err}");
    assert!(
        !saved.exists()
            || std::fs::read_dir(&saved)
                .map(|mut d| d.next().is_none())
                .unwrap_or(true)
    );

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn a_revoked_author_becomes_stale_and_cannot_reinstall() {
    let base = temp("revoke");
    let project = base.join("project");
    fixture_project(&project);
    let out = base.join("out");
    let saved = base.join("saved");
    let store = base.join("store");
    let signer = MockSigningClient::new();
    let me = Identity {
        login: "mallory".into(),
    };

    build_package(&project, &out, &me, &signer).expect("build");
    let entry = discover(&out).remove(0);
    install(&entry, &roots(&saved), &store, &signer).expect("install");
    assert!(revalidate_installed(&store, &signer).unwrap().is_empty());

    // The author is reported nefarious and revoked on the server.
    signer.revoke("mallory");

    let stale = revalidate_installed(&store, &signer).expect("revalidate");
    assert_eq!(stale.len(), 1);
    assert_eq!(stale[0].author, "mallory");
    assert_eq!(stale[0].status, "revoked");

    // And a fresh install of the same package is now refused.
    uninstall(&entry.id, &store).expect("uninstall");
    let err = install(&entry, &roots(&saved), &store, &signer).expect_err("revoked refused");
    assert!(err.contains("rejected") || err.contains("revoked"), "{err}");

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn an_unreachable_server_marks_installed_packages_unverified_not_trusted() {
    // Fail-closed: a signing-server outage must NOT silently clear a package to
    // trusted — it is reported "unverified" (a standing warning).
    let base = temp("unverified");
    let project = base.join("project");
    fixture_project(&project);
    let out = base.join("out");
    let saved = base.join("saved");
    let store = base.join("store");
    let signer = MockSigningClient::new();
    let me = Identity {
        login: "alice".into(),
    };
    build_package(&project, &out, &me, &signer).expect("build");
    let entry = discover(&out).remove(0);
    install(&entry, &roots(&saved), &store, &signer).expect("install");

    let stale = revalidate_installed(&store, &OfflineSigner).expect("revalidate");
    assert_eq!(stale.len(), 1);
    assert_eq!(stale[0].status, "unverified");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn build_requires_a_logged_in_identity() {
    let base = temp("login");
    let project = base.join("project");
    fixture_project(&project);
    let signer = MockSigningClient::new();
    // Logged out → packaging is refused (model BuildRequiresLogin).
    let err = build_package_with(
        &project,
        &base.join("out"),
        &StaticIdentity::logged_out(),
        &signer,
    )
    .expect_err("logged out must be refused");
    assert!(err.contains("signed in"), "{err}");
    // Logged in → it packages.
    build_package_with(
        &project,
        &base.join("out"),
        &StaticIdentity::new("alice"),
        &signer,
    )
    .expect("logged in builds");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn reinstalling_over_an_existing_install_replaces_it_cleanly() {
    let base = temp("reinstall");
    let project = base.join("project");
    fixture_project(&project);
    let out = base.join("out");
    let saved = base.join("saved");
    let store = base.join("store");
    let signer = MockSigningClient::new();
    let me = Identity {
        login: "alice".into(),
    };
    build_package(&project, &out, &me, &signer).expect("build");
    let entry = discover(&out).remove(0);

    install(&entry, &roots(&saved), &store, &signer).expect("install 1");
    // Re-install WITHOUT uninstalling first must succeed (idempotent), not
    // collide with its own surviving destination links.
    let report = install(&entry, &roots(&saved), &store, &signer).expect("install 2");
    assert_eq!(report.linked, 3);
    assert_eq!(
        std::fs::read_to_string(saved.join("Mods/mod.lua")).unwrap(),
        "print('mod')\n"
    );
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn install_refuses_a_signed_manifest_whose_rule_escapes_the_root() {
    // A forged but VALIDLY SIGNED package whose manifest rule escapes the root
    // must still be refused at install time (defense in depth beyond build).
    let base = temp("install-escape");
    let project = base.join("project");
    fixture_project(&project);
    let out = base.join("out");
    let signer = MockSigningClient::new();
    let me = Identity {
        login: "alice".into(),
    };
    let artifact = build_package(&project, &out, &me, &signer).expect("build");

    // Extract the payload, then re-sign a manifest with an escaping rule and the
    // matching payload hash, so validation passes but the rule guard must fire.
    let payload = base.join("payload");
    studio_packages::archive::extract_payload(&artifact, &payload).expect("extract");
    let forged = PackageManifest {
        name: "Forged".into(),
        version: "1.0.0".into(),
        author: "alice".into(),
        created_at: "0".into(),
        content_hash: studio_packages::hash::content_hash(&payload).expect("hash"),
        rules: vec![Rule {
            source: "../../etc/evil".into(),
            dest: "{SavedGames}/x".into(),
        }],
    };
    let sig = signer.sign(&me, &forged).expect("sign forged");
    let forged_path = out.join("forged.dcspkg");
    studio_packages::archive::write(&forged_path, &forged, &sig, &payload).expect("rezip");

    let entry = entry_for(&forged_path).expect("entry");
    let saved = base.join("saved");
    let store = base.join("store");
    let err = install(&entry, &roots(&saved), &store, &signer).expect_err("escape refused");
    assert!(err.contains("escapes"), "{err}");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn an_escaping_install_rule_is_refused_at_build() {
    let base = temp("escape");
    let project = base.join("project");
    write(
        &project.join("dcs-studio.toml"),
        r#"
[project]
name = "Evil"
[[install]]
source = "../../etc/evil"
dest = "{SavedGames}/x"
"#,
    );
    let signer = MockSigningClient::new();
    let me = Identity {
        login: "alice".into(),
    };
    let err = build_package(&project, &base.join("out"), &me, &signer).expect_err("escape refused");
    assert!(err.contains("escapes"), "{err}");
    let _ = std::fs::remove_dir_all(&base);
}
