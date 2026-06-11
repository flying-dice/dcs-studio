//! The `fmt` subcommand's contract (model: `fmt::Fmt`; decisions/006):
//! in-place formatting walks directories like `check`, `--check` is the
//! CI gate (exit 1 only when a file would change), unparseable files are
//! reported and skipped without affecting the exit code (parse errors
//! are `check`'s job), and `[format]` in `dcs-studio.toml` governs the
//! output. Pins the real binary, not `fmt::run` in isolation.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn fmt(args: &[&str], cwd: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_dcs-studio-cli"))
        .arg("fmt")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("spawn dcs-studio-cli fmt")
}

fn temp_project(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dcs-fmt-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

#[test]
fn formats_in_place_and_is_then_stable() {
    let dir = temp_project("inplace");
    let file = dir.join("messy.lua");
    std::fs::write(&file, "local x=1\nif x then y=x   end\n").expect("write");

    let output = fmt(&["."], &dir);
    assert!(
        output.status.success(),
        "fmt must exit 0, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let formatted = std::fs::read_to_string(&file).expect("read back");
    assert_eq!(formatted, "local x = 1\nif x then\n    y = x\nend\n");

    // The atomic write leaves no temp residue behind.
    let names: Vec<String> = std::fs::read_dir(&dir)
        .expect("list dir")
        .map(|e| e.expect("entry").file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(names, vec!["messy.lua"], "no temp files may linger");

    // Second run: nothing changes, file list is empty.
    let output = fmt(&["."], &dir);
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        !stdout.contains("messy.lua"),
        "an already-formatted file must not be listed, got: {stdout}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn check_mode_exits_nonzero_and_writes_nothing() {
    let dir = temp_project("check");
    let file = dir.join("messy.lua");
    let original = "local x   =   1\n";
    std::fs::write(&file, original).expect("write");

    let output = fmt(&["--check", "."], &dir);
    assert!(
        !output.status.success(),
        "--check with a diff must exit nonzero"
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("messy.lua"), "must list the file: {stdout}");
    assert_eq!(
        std::fs::read_to_string(&file).expect("read back"),
        original,
        "--check must not write"
    );

    // A clean tree passes.
    std::fs::write(&file, "local x = 1\n").expect("write");
    let output = fmt(&["--check", "."], &dir);
    assert!(
        output.status.success(),
        "--check on formatted tree must exit 0, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn unparseable_files_are_skipped_and_do_not_gate() {
    let dir = temp_project("broken");
    let broken = dir.join("broken.lua");
    std::fs::write(&broken, "function f(\nlocal x = 1\n").expect("write");
    std::fs::write(dir.join("fine.lua"), "local ok = true\n").expect("write");

    // Plain fmt: reported, skipped, exit 0; the broken file is untouched.
    let output = fmt(&["."], &dir);
    assert!(
        output.status.success(),
        "parse errors must not fail fmt, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("broken.lua") && stderr.contains("does not parse"),
        "must report the skip: {stderr}"
    );
    assert_eq!(
        std::fs::read_to_string(&broken).expect("read back"),
        "function f(\nlocal x = 1\n",
        "a file that does not parse must come back byte-identical"
    );

    // --check with only parse errors (everything else formatted): exit 0 —
    // surfacing syntax errors is `check`'s job.
    let output = fmt(&["--check", "."], &dir);
    assert!(
        output.status.success(),
        "--check must not gate on parse errors, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn nonexistent_path_is_an_error() {
    let dir = temp_project("missing");
    let output = fmt(&["no-such-file.lua"], &dir);
    assert!(!output.status.success(), "a missing path must not exit 0");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("does not exist"), "got: {stderr}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn manifest_format_section_governs_output() {
    let dir = temp_project("config");
    std::fs::write(
        dir.join("dcs-studio.toml"),
        "[project]\nname = \"cfg\"\n\n[format]\nindent_width = 2\nquote_style = \"single\"\n",
    )
    .expect("write manifest");
    let file = dir.join("script.lua");
    std::fs::write(&file, "if x then y = \"v\" end\n").expect("write");

    let output = fmt(&["."], &dir);
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(&file).expect("read back"),
        "if x then\n  y = 'v'\nend\n"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
