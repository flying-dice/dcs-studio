//! CLI smoke: `pkg list` discovers a built `.dcspkg` (no network — the artifact
//! is built in-process with the mock signer, then listed via the real binary).

use std::path::{Path, PathBuf};
use std::process::Command;

use studio_packages::{Identity, MockSigningClient, build_package};

fn temp(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cli-pkg-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp");
    dir
}

fn write(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
}

#[test]
fn pkg_list_shows_a_built_package() {
    let base = temp("list");
    let project = base.join("project");
    write(
        &project.join("dcs-studio.toml"),
        "[project]\nname = \"Demo Mod\"\nversion = \"0.1.0\"\n\n[[install]]\nsource = \"mod.lua\"\ndest = \"{SavedGames}/Mods\"\n",
    );
    write(&project.join("mod.lua"), "print('hi')\n");
    let out = base.join("out");
    build_package(
        &project,
        &out,
        &Identity {
            login: "alice".into(),
        },
        &MockSigningClient::new(),
    )
    .expect("build package");

    let output = Command::new(env!("CARGO_BIN_EXE_dcs-studio-cli"))
        .args(["pkg", "list", out.to_str().unwrap()])
        .output()
        .expect("run cli");
    assert!(output.status.success(), "{output:?}");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Demo Mod"), "stdout was: {stdout}");
    assert!(stdout.contains("by alice"), "stdout was: {stdout}");

    let _ = std::fs::remove_dir_all(&base);
}
