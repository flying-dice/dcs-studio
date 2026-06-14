//! End-to-end over the in-process `MockSigningClient` (model `studio::package`):
//! build → discover → install → links placed → uninstall, plus the three refusal
//! arms — tampered payload, revoked author, escaping rule.

use std::path::{Path, PathBuf};

use dcs_studio_project::RootMap;
use studio_packages::{
    build_package, discover, install, revalidate_installed, uninstall, Identity, MockSigningClient,
};

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

    // And a fresh install of the same package is now refused.
    uninstall(&entry.id, &store).expect("uninstall");
    let err = install(&entry, &roots(&saved), &store, &signer).expect_err("revoked refused");
    assert!(err.contains("rejected") || err.contains("revoked"), "{err}");

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
