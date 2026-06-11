//! The `check` subcommand's exit-code contract (MR !7 finding 2): a
//! nonexistent root is an error — analysing nothing must never gate as
//! success — while an empty-but-existing directory is legitimately clean
//! (a blank project has no findings). Pins the real binary's behaviour,
//! not `check::run` in isolation, because the guard lives in the CLI arm.

use std::path::Path;
use std::process::{Command, Output};

fn check(root: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_dcs-studio-cli"))
        .arg("check")
        .arg(root)
        .output()
        .expect("spawn dcs-studio-cli check")
}

#[test]
fn nonexistent_root_is_an_error() {
    let missing = std::env::temp_dir().join(format!("dcs-check-missing-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&missing);

    let output = check(&missing);

    assert!(
        !output.status.success(),
        "check of a nonexistent root must not exit 0"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("does not exist"),
        "stderr should name the failure, got: {stderr}"
    );
}

#[test]
fn empty_existing_dir_is_clean() {
    let empty = std::env::temp_dir().join(format!("dcs-check-empty-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&empty);
    std::fs::create_dir_all(&empty).expect("temp dir");

    let output = check(&empty);

    assert!(
        output.status.success(),
        "check of an empty existing dir must exit 0, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let _ = std::fs::remove_dir_all(&empty);
}
