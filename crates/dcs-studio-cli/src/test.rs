//! `dcs-studio-cli test` — run the project's Lua unit tests outside DCS
//! (issue #9; model: `studio::cli::Cli.Test`).
//!
//! Discovery follows the manifest's `[test]` table (`dir`, `suffix`;
//! defaults `tests` + `.test.lua`). Execution is delegated to the
//! external `dcs-lua-runner` binary — found next to this exe, or via the
//! `DCS_LUA_RUNNER` env override (the same pattern as `DCS_STUDIO_CLI`
//! for the app) — which runs every spec in a fresh Lua 5.1 state and
//! answers JSON. A missing runner is an error, never a silent pass: a
//! gate built on `test` must go red.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

use serde::Deserialize;
use walkdir::WalkDir;

/// How results render.
#[derive(Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum Reporter {
    /// Per-case terminal output plus a summary line.
    Pretty,
    /// `JUnit` XML on disk (see `--junit-out`) plus the summary line.
    Junit,
}

#[derive(Deserialize)]
struct RunnerOutput {
    files: Vec<FileResult>,
}

#[derive(Deserialize)]
struct FileResult {
    path: String,
    cases: Vec<TestCase>,
}

#[derive(Deserialize)]
struct TestCase {
    name: String,
    passed: bool,
    message: String,
    line: u32,
}

/// The whole subcommand: discover, delegate, render, gate.
pub fn run(root: &Path, reporter: Reporter, junit_out: &Path) -> ExitCode {
    // Same contract as `check`: a nonexistent root is an error, never a
    // clean run.
    if !root.is_dir() {
        eprintln!("test: '{}' does not exist", root.display());
        return ExitCode::FAILURE;
    }
    // Runner first (model order): a gate must go red on a missing runner
    // even before discovery finds anything.
    let runner = match find_runner() {
        Ok(runner) => runner,
        Err(message) => {
            eprintln!("test: {message}");
            return ExitCode::FAILURE;
        }
    };
    let (dir, suffix) = match test_config(root) {
        Ok(config) => config,
        Err(message) => {
            eprintln!("test: {message}");
            return ExitCode::FAILURE;
        }
    };
    let specs = discover(root, &dir, &suffix);
    if specs.is_empty() {
        println!("no test files found under {dir}/ (suffix {suffix})");
        return ExitCode::SUCCESS;
    }

    let output = match spawn_runner(&runner, root, &specs) {
        Ok(output) => output,
        Err(message) => {
            eprintln!("test: {message}");
            return ExitCode::FAILURE;
        }
    };

    let (passed, failed) = tally(&output);
    match reporter {
        Reporter::Pretty => render_pretty(&output),
        Reporter::Junit => {
            if let Err(message) = write_junit(&output, junit_out) {
                eprintln!("test: {message}");
                return ExitCode::FAILURE;
            }
            println!("wrote {}", junit_out.display());
        }
    }
    println!(
        "{passed} passed, {failed} failed ({} file{})",
        output.files.len(),
        if output.files.len() == 1 { "" } else { "s" }
    );

    if failed > 0 {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

/// `[test]` from the manifest when one exists; defaults otherwise (a
/// manifest-less folder is still testable). A malformed manifest is a
/// hard error, never a fallback — defaulting would silently redirect
/// discovery away from the configured specs.
fn test_config(root: &Path) -> Result<(String, String), String> {
    if !root.join("dcs-studio.toml").is_file() {
        let defaults = dcs_studio_project::manifest::TestConfig::default();
        return Ok((defaults.dir, defaults.suffix));
    }
    let manifest = dcs_studio_project::manifest::load(root)?;
    Ok((manifest.test.dir, manifest.test.suffix))
}

/// Root-relative spec paths under `<root>/<dir>`, sorted for stable
/// output and `JUnit` ordering.
fn discover(root: &Path, dir: &str, suffix: &str) -> Vec<String> {
    let base = root.join(dir);
    let mut specs: Vec<String> = WalkDir::new(&base)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_file() && entry.file_name().to_string_lossy().ends_with(suffix)
        })
        .filter_map(|entry| {
            let relative = entry.path().strip_prefix(root).ok()?;
            // Forward slashes: the path is also the Lua chunk name and
            // the JUnit suite name, identical on every platform.
            Some(relative.display().to_string().replace('\\', "/"))
        })
        .collect();
    specs.sort();
    specs
}

/// The runner binary: `DCS_LUA_RUNNER` wins; otherwise the sibling of
/// this exe. An explicitly-pointed-at-but-missing runner is an error,
/// not a fallback.
fn find_runner() -> Result<PathBuf, String> {
    if let Some(overridden) = std::env::var_os("DCS_LUA_RUNNER") {
        let path = PathBuf::from(overridden);
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!(
            "DCS_LUA_RUNNER points at '{}', which does not exist",
            path.display()
        ));
    }
    let exe = std::env::current_exe().map_err(|e| format!("locating this executable: {e}"))?;
    let name = if cfg!(windows) {
        "dcs-lua-runner.exe"
    } else {
        "dcs-lua-runner"
    };
    let sibling = exe.with_file_name(name);
    if sibling.is_file() {
        return Ok(sibling);
    }
    Err(format!(
        "lua test runner not found at '{}' — build it with `cargo build --manifest-path \
         tools/lua-runner/Cargo.toml` and put dcs-lua-runner next to dcs-studio-cli, \
         or set DCS_LUA_RUNNER",
        sibling.display()
    ))
}

/// Spec JSON over stdin, results JSON from stdout.
fn spawn_runner(runner: &Path, root: &Path, specs: &[String]) -> Result<RunnerOutput, String> {
    let spec = serde_json::json!({ "root": root, "files": specs });
    let mut child = Command::new(runner)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawning {}: {e}", runner.display()))?;
    child
        .stdin
        .take()
        .expect("stdin was piped")
        .write_all(spec.to_string().as_bytes())
        .map_err(|e| format!("writing the spec to the runner: {e}"))?;
    let output = child
        .wait_with_output()
        .map_err(|e| format!("waiting for the runner: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "the runner failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    serde_json::from_slice(&output.stdout).map_err(|e| format!("parsing runner results: {e}"))
}

fn tally(output: &RunnerOutput) -> (usize, usize) {
    let mut passed = 0;
    let mut failed = 0;
    for file in &output.files {
        for case in &file.cases {
            if case.passed {
                passed += 1;
            } else {
                failed += 1;
            }
        }
    }
    (passed, failed)
}

fn render_pretty(output: &RunnerOutput) {
    for file in &output.files {
        println!("{}", file.path);
        for case in &file.cases {
            if case.passed {
                println!("  PASS {}", case.name);
            } else {
                println!("  FAIL {} ({}:{})", case.name, file.path, case.line);
                println!("       {}", case.message);
            }
        }
    }
}

/// One `<testsuite>` per spec file, one `<testcase>` per case; failures
/// carry the matcher message and line.
fn write_junit(output: &RunnerOutput, junit_out: &Path) -> Result<(), String> {
    use std::fmt::Write as _;

    let (_, failed) = tally(output);
    let total: usize = output.files.iter().map(|file| file.cases.len()).sum();
    let mut xml = String::new();
    let _ = writeln!(xml, r#"<?xml version="1.0" encoding="UTF-8"?>"#);
    let _ = writeln!(
        xml,
        r#"<testsuites name="dcs-studio test" tests="{total}" failures="{failed}">"#
    );
    for file in &output.files {
        let file_failed = file.cases.iter().filter(|case| !case.passed).count();
        let _ = writeln!(
            xml,
            r#"  <testsuite name="{}" tests="{}" failures="{file_failed}">"#,
            escape(&file.path),
            file.cases.len()
        );
        for case in &file.cases {
            if case.passed {
                let _ = writeln!(
                    xml,
                    r#"    <testcase classname="{}" name="{}"/>"#,
                    escape(&file.path),
                    escape(&case.name)
                );
            } else {
                let _ = writeln!(
                    xml,
                    r#"    <testcase classname="{}" name="{}">"#,
                    escape(&file.path),
                    escape(&case.name)
                );
                let _ = writeln!(
                    xml,
                    r#"      <failure message="{}">{}:{}</failure>"#,
                    escape(&case.message),
                    escape(&file.path),
                    case.line
                );
                let _ = writeln!(xml, "    </testcase>");
            }
        }
        let _ = writeln!(xml, "  </testsuite>");
    }
    let _ = writeln!(xml, "</testsuites>");

    std::fs::write(junit_out, xml).map_err(|e| format!("writing {}: {e}", junit_out.display()))
}

fn escape(text: &str) -> String {
    // XML attribute values must not contain raw newlines or carriage
    // returns — escape them as character references so any well-formed
    // XML parser recovers them verbatim (XML 1.0 §3.3.3).
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
        .replace('\n', "&#xA;")
        .replace('\r', "&#xD;")
}
