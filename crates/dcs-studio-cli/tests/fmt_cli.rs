//! The `fmt` subcommand's contract (model: `fmt::Fmt`; decisions/006):
//! in-place formatting walks directories like `check`, `--check` is the
//! CI gate (exit 1 when a file would change or the internal guard
//! trips), unparseable files are reported and skipped without affecting
//! the exit code (parse errors are `check`'s job), and `[format]` in
//! `dcs-studio.toml` governs the output. Pins the real binary, not
//! `fmt::run` in isolation.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn fmt(args: &[&str], cwd: &Path) -> Output {
    fmt_with_env(args, cwd, &[])
}

fn fmt_with_env(args: &[&str], cwd: &Path, env: &[(&str, &str)]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_dcs-studio-cli"));
    command.arg("fmt").args(args).current_dir(cwd);
    for (key, value) in env {
        command.env(key, value);
    }
    command.output().expect("spawn dcs-studio-cli fmt")
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

/// An invalid `[format]` value is reported on stderr and falls back to
/// house defaults — a typo in the manifest must not block formatting.
#[test]
fn invalid_manifest_format_falls_back_to_defaults_with_a_note() {
    let dir = temp_project("badcfg");
    std::fs::write(
        dir.join("dcs-studio.toml"),
        "[project]\nname = \"cfg\"\n\n[format]\nquote_style = \"sideways\"\n",
    )
    .expect("write manifest");
    let file = dir.join("script.lua");
    std::fs::write(&file, "local s = 'x'\n").expect("write");

    let output = fmt(&["."], &dir);
    assert!(
        output.status.success(),
        "an invalid manifest must not fail fmt, stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("using default format config"),
        "the fallback must be reported: {stderr}"
    );
    assert_eq!(
        std::fs::read_to_string(&file).expect("read back"),
        "local s = \"x\"\n",
        "house defaults (double quotes) must govern"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// The guard-trip arm: warn loudly on stderr, leave the file unchanged,
/// keep walking — and fail the exit code in BOTH modes (decisions/006:
/// a trip is an internal formatter bug leaving a file non-canonical, so
/// a gate built on fmt must go red; the walk still continues so every
/// affected file gets named). A real trip requires a formatter bug, so
/// the debug-only `DCS_STUDIO_FMT_FORCE_GUARD_TRIP` hook forces one.
#[test]
fn guard_trip_warns_leaves_file_unchanged_and_continues() {
    let dir = temp_project("trip");
    let original = "local x   =   1\n";
    std::fs::write(dir.join("a.lua"), original).expect("write");
    std::fs::write(dir.join("b.lua"), original).expect("write");

    for args in [&["."][..], &["--check", "."][..]] {
        let output = fmt_with_env(args, &dir, &[("DCS_STUDIO_FMT_FORCE_GUARD_TRIP", "1")]);
        assert!(
            !output.status.success(),
            "fmt {args:?}: a guard trip must fail the exit code, stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(
            stderr.matches("formatter guard tripped").count(),
            2,
            "fmt {args:?}: both files must warn (the walk continues): {stderr}"
        );
        for name in ["a.lua", "b.lua"] {
            assert_eq!(
                std::fs::read_to_string(dir.join(name)).expect("read back"),
                original,
                "fmt {args:?}: {name}: a tripped file must come back byte-identical"
            );
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// The atomic-write error arm: when the rename over the original fails,
/// the temp file is cleaned up, the failure is reported, and fmt exits
/// nonzero. Windows-only: an open handle without `FILE_SHARE_DELETE`
/// makes the rename fail while reads still succeed.
#[cfg(windows)]
#[test]
fn failed_rename_cleans_up_the_temp_file_and_fails() {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 1;

    let dir = temp_project("renamefail");
    let file = dir.join("messy.lua");
    std::fs::write(&file, "local x   =   1\n").expect("write");
    // Hold the destination open allowing reads but not delete/rename.
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(&file)
        .expect("open with restrictive share mode");

    let output = fmt(&["."], &dir);
    assert!(!output.status.success(), "a failed write must exit nonzero");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("fmt: writing"),
        "the failure must be reported: {stderr}"
    );
    assert_eq!(
        std::fs::read_to_string(&file).expect("read back"),
        "local x   =   1\n",
        "the original must be intact"
    );
    let names: Vec<String> = std::fs::read_dir(&dir)
        .expect("list dir")
        .map(|e| e.expect("entry").file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(names, vec!["messy.lua"], "the temp file must be cleaned up");
    drop(lock);
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
