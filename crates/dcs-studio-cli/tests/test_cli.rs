//! The `test` subcommand end-to-end (issue #9; model:
//! `studio::cli::Cli.Test` + feature `FailingTestFailsBuild`): real CLI
//! binary, real dcs-lua-runner, scaffolded temp projects.
//!
//! Runner discovery for THIS suite mirrors `host_ipc.rs`: `DCS_LUA_RUNNER`
//! first (CI builds tools/lua-runner and pins it), then the runner's own
//! target dir from a local `cargo build --manifest-path
//! tools/lua-runner/Cargo.toml`. Tests that need a live runner SKIP
//! (eprintln + success) when neither yields a binary; the
//! runner-missing/contract tests run everywhere.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// The built dcs-lua-runner, or None (callers skip).
fn runner_binary() -> Option<PathBuf> {
    if let Some(pinned) = std::env::var_os("DCS_LUA_RUNNER") {
        let path = PathBuf::from(pinned);
        return path.is_file().then_some(path);
    }
    let name = if cfg!(windows) {
        "dcs-lua-runner.exe"
    } else {
        "dcs-lua-runner"
    };
    let local = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tools/lua-runner/target/debug")
        .join(name);
    local.is_file().then_some(local)
}

fn temp_project(tag: &str, manifest: &str, files: &[(&str, &str)]) -> PathBuf {
    let root = std::env::temp_dir().join(format!("dcs-test-cli-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).expect("temp root");
    std::fs::write(root.join("dcs-studio.toml"), manifest).expect("manifest");
    for (path, contents) in files {
        let full = root.join(path);
        std::fs::create_dir_all(full.parent().expect("parent")).expect("dirs");
        std::fs::write(full, contents).expect("file");
    }
    root
}

fn run_test_subcommand(root: &Path, runner: &Path, extra: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_dcs-studio-cli"))
        .arg("test")
        .arg(root)
        .args(extra)
        .env("DCS_LUA_RUNNER", runner)
        .output()
        .expect("spawn dcs-studio-cli test")
}

const MINIMAL_MANIFEST: &str = "[project]\nname = \"Test CLI Probe\"\n";

const MIXED_SPECS: &[(&str, &str)] = &[
    (
        "tests/math.test.lua",
        "describe(\"math\", function()\n  test(\"adds\", function()\n    expect(1 + 1).toBe(2)\n  end)\nend)\n",
    ),
    (
        "tests/broken.test.lua",
        "test(\"a failing case with <&\\\"specials>\", function()\n  expect(\"got\").toBe(\"want\")\nend)\n",
    ),
];

#[test]
fn failing_test_fails_the_build_passing_suite_passes() {
    let Some(runner) = runner_binary() else {
        eprintln!("SKIP test_cli: build tools/lua-runner first or set DCS_LUA_RUNNER");
        return;
    };

    // One passing + one failing spec: nonzero, and the failure is named
    // with file and line.
    let mixed = temp_project("mixed", MINIMAL_MANIFEST, MIXED_SPECS);
    let output = run_test_subcommand(&mixed, &runner, &[]);
    assert!(
        !output.status.success(),
        "a failing test must fail the run"
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("PASS math > adds"), "stdout: {stdout}");
    assert!(
        stdout.contains("FAIL a failing case with <&\"specials> (tests/broken.test.lua:2)"),
        "stdout: {stdout}"
    );
    assert!(stdout.contains("1 passed, 1 failed (2 files)"), "{stdout}");
    let _ = std::fs::remove_dir_all(&mixed);

    // Passing-only: exit 0.
    let passing = temp_project("passing", MINIMAL_MANIFEST, &MIXED_SPECS[..1]);
    let output = run_test_subcommand(&passing, &runner, &[]);
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let _ = std::fs::remove_dir_all(&passing);
}

#[test]
fn junit_reporter_writes_wellformed_escaped_xml_and_still_gates() {
    let Some(runner) = runner_binary() else {
        eprintln!("SKIP test_cli: build tools/lua-runner first or set DCS_LUA_RUNNER");
        return;
    };
    let root = temp_project("junit", MINIMAL_MANIFEST, MIXED_SPECS);
    let junit_path = root.join("report.xml");

    let output = run_test_subcommand(
        &root,
        &runner,
        &["--reporter", "junit", "--junit-out", junit_path.to_str().expect("utf8")],
    );

    assert!(!output.status.success(), "junit reporter must still gate");
    let xml = std::fs::read_to_string(&junit_path).expect("junit file written");
    assert!(xml.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"));
    assert!(
        xml.contains(r#"<testsuites name="dcs-studio test" tests="2" failures="1">"#),
        "{xml}"
    );
    assert!(xml.contains(r#"<testsuite name="tests/math.test.lua" tests="1" failures="0">"#));
    // The raw specials from the test name must arrive escaped...
    assert!(
        xml.contains("a failing case with &lt;&amp;&quot;specials&gt;"),
        "{xml}"
    );
    // ...and never raw (which would break any consumer).
    assert!(!xml.contains("<&\"specials>"), "{xml}");
    assert!(xml.contains(r#"<failure message="expected &quot;got&quot; to be &quot;want&quot;">"#));
    // Balanced structure: every opened suite/case closes.
    assert_eq!(xml.matches("<testsuite ").count(), 2);
    assert_eq!(xml.matches("</testsuite>").count(), 2);
    assert_eq!(xml.matches("<testsuites ").count(), 1);
    assert!(xml.trim_end().ends_with("</testsuites>"));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn manifest_test_table_redirects_discovery() {
    let Some(runner) = runner_binary() else {
        eprintln!("SKIP test_cli: build tools/lua-runner first or set DCS_LUA_RUNNER");
        return;
    };
    let root = temp_project(
        "testdir",
        "[project]\nname = \"x\"\n\n[test]\ndir = \"specs\"\n",
        &[
            // In the configured dir: found (and failing, to prove it ran).
            (
                "specs/found.test.lua",
                "test(\"runs from specs/\", function()\n  expect(true).toBeFalsy()\nend)\n",
            ),
            // In the default dir: must NOT run once [test].dir says specs/.
            (
                "tests/ignored.test.lua",
                "test(\"must not run\", function()\n  error(\"discovery leaked into tests/\")\nend)\n",
            ),
        ],
    );

    let output = run_test_subcommand(&root, &runner, &[]);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(!output.status.success());
    assert!(stdout.contains("specs/found.test.lua"), "{stdout}");
    assert!(!stdout.contains("ignored.test.lua"), "{stdout}");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn missing_runner_is_a_clear_error_never_a_silent_pass() {
    let root = temp_project("no-runner", MINIMAL_MANIFEST, &MIXED_SPECS[..1]);
    let missing = std::env::temp_dir().join("definitely-not-a-runner.exe");

    let output = Command::new(env!("CARGO_BIN_EXE_dcs-studio-cli"))
        .arg("test")
        .arg(&root)
        .env("DCS_LUA_RUNNER", &missing)
        .output()
        .expect("spawn dcs-studio-cli test");

    assert!(
        !output.status.success(),
        "a missing runner must not exit 0"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("DCS_LUA_RUNNER points at") && stderr.contains("does not exist"),
        "stderr should name the failure, got: {stderr}"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn malformed_manifest_is_an_error_not_a_discovery_fallback() {
    let root = temp_project(
        "bad-manifest",
        "[test\ndir = broken",
        &[(
            "tests/present.test.lua",
            "test(\"would pass\", function() end)\n",
        )],
    );
    // The runner is irrelevant here, but pin one anyway so the failure
    // cannot be the missing-runner arm.
    let missing_arm_proof = std::env::current_exe().expect("self");

    let output = Command::new(env!("CARGO_BIN_EXE_dcs-studio-cli"))
        .arg("test")
        .arg(&root)
        .env("DCS_LUA_RUNNER", &missing_arm_proof)
        .output()
        .expect("spawn dcs-studio-cli test");

    assert!(
        !output.status.success(),
        "a malformed manifest must not fall back to default discovery"
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("dcs-studio.toml"),
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn nonexistent_root_is_an_error() {
    let missing_root =
        std::env::temp_dir().join(format!("dcs-test-cli-missing-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&missing_root);

    let output = Command::new(env!("CARGO_BIN_EXE_dcs-studio-cli"))
        .arg("test")
        .arg(&missing_root)
        .output()
        .expect("spawn dcs-studio-cli test");

    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("does not exist"),
    );
}

/// The executable half of `ScaffoldedProjectPassesCi`: a fresh
/// lua-script scaffold's own sample suite passes `test`, and its
/// `[build]` table bundles — the same two commands the scaffolded
/// GitHub workflow runs (the workflow file itself is pinned by
/// template-content tests in dcs-studio-project).
#[test]
fn scaffolded_lua_script_passes_test_and_bundle() {
    let Some(runner) = runner_binary() else {
        eprintln!("SKIP test_cli: build tools/lua-runner first or set DCS_LUA_RUNNER");
        return;
    };
    let parent = std::env::temp_dir().join(format!("dcs-scaffold-ci-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&parent);
    std::fs::create_dir_all(&parent).expect("parent dir");

    let init = Command::new(env!("CARGO_BIN_EXE_dcs-studio-cli"))
        .args(["init", "Sample Mod", "--template", "lua-script", "--parent"])
        .arg(&parent)
        .output()
        .expect("spawn init");
    assert!(
        init.status.success(),
        "init failed: {}",
        String::from_utf8_lossy(&init.stderr)
    );
    let root = parent.join("Sample Mod");

    let tested = run_test_subcommand(&root, &runner, &[]);
    assert!(
        tested.status.success(),
        "the scaffold's sample suite must pass:\n{}\n{}",
        String::from_utf8_lossy(&tested.stdout),
        String::from_utf8_lossy(&tested.stderr)
    );
    let stdout = String::from_utf8_lossy(&tested.stdout);
    assert!(stdout.contains("3 passed, 0 failed"), "{stdout}");

    let bundled = Command::new(env!("CARGO_BIN_EXE_dcs-studio-cli"))
        .arg("bundle")
        .arg(&root)
        .output()
        .expect("spawn bundle");
    assert!(
        bundled.status.success(),
        "the scaffold must bundle: {}",
        String::from_utf8_lossy(&bundled.stderr)
    );
    assert!(
        root.join("dist/sample-mod.lua").is_file(),
        "[build] output lands under dist/"
    );
    let _ = std::fs::remove_dir_all(&parent);
}

#[test]
fn no_spec_files_is_clean_but_says_so() {
    let Some(runner) = runner_binary() else {
        eprintln!("SKIP test_cli: build tools/lua-runner first or set DCS_LUA_RUNNER");
        return;
    };
    let root = temp_project("empty", MINIMAL_MANIFEST, &[]);

    let output = run_test_subcommand(&root, &runner, &[]);

    assert!(output.status.success(), "no tests is clean, not failing");
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("no test files found under tests/"),
    );
    let _ = std::fs::remove_dir_all(&root);
}
