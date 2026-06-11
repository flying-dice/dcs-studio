//! The `bundle` subcommand end-to-end (issue #9; model:
//! `studio::cli::Bundler` + feature `BundlePreservesRequireSemantics`):
//! golden output for a three-module fixture, cycle refusal, the PUC
//! `luac -p` oracle (when `DCS_PUC_LUAC` is set, as CI does), and the
//! bundle EXECUTING under the runner's real Lua 5.1 with require
//! semantics intact.
//!
//! Fixture sources and the golden live inline as hand-written constants
//! (never assembled from the implementation's output) so line endings
//! are identical on every platform.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const FIXTURE_MANIFEST: &str = "[project]\nname = \"Bundle Fixture\"\n\n[build]\nentry = \"Scripts/fix/main.lua\"\noutput = \"bundle.lua\"\n";

const UTIL_LUA: &str = "-- counts executions so tests can prove single-execution\nUTIL_EXECUTIONS = (UTIL_EXECUTIONS or 0) + 1\n\nlocal util = {}\n\nfunction util.double(n)\n  return n * 2\nend\n\nreturn util\n";

const GEOMETRY_LUA: &str = "local util = require(\"Scripts.fix.util\")\n\nlocal geometry = {}\ngeometry.util = util\n\nfunction geometry.perimeter(side)\n  return util.double(side) + util.double(side)\nend\n\nreturn geometry\n";

const MAIN_LUA: &str = "local util = require(\"Scripts.fix.util\")\nlocal geometry = require(\"Scripts.fix.geometry\")\n\n-- not project-local: left untouched for the DCS runtime to provide\nlocal has_socket = pcall(require, \"socket\")\n\nBUNDLE_PROBE = {\n  same_util = geometry.util == util,\n  executions = UTIL_EXECUTIONS,\n  perimeter = geometry.perimeter(3),\n  has_socket = has_socket,\n}\n";

/// Hand-written expectation: header, preload entries in dependency order
/// (util before geometry — geometry requires util), then the entry body.
const GOLDEN_BUNDLE: &str = concat!(
    "-- Bundled by `dcs-studio-cli bundle`. DO NOT EDIT — edit the sources and re-bundle.\n",
    "-- Entry: Scripts/fix/main.lua\n",
    "-- Modules are registered in package.preload so require() keeps its exact\n",
    "-- semantics: single execution, cached module table identity.\n",
    "\n",
    "package.preload[\"Scripts.fix.util\"] = function(...)\n",
    "-- counts executions so tests can prove single-execution\n",
    "UTIL_EXECUTIONS = (UTIL_EXECUTIONS or 0) + 1\n",
    "\n",
    "local util = {}\n",
    "\n",
    "function util.double(n)\n",
    "  return n * 2\n",
    "end\n",
    "\n",
    "return util\n",
    "end\n",
    "\n",
    "package.preload[\"Scripts.fix.geometry\"] = function(...)\n",
    "local util = require(\"Scripts.fix.util\")\n",
    "\n",
    "local geometry = {}\n",
    "geometry.util = util\n",
    "\n",
    "function geometry.perimeter(side)\n",
    "  return util.double(side) + util.double(side)\n",
    "end\n",
    "\n",
    "return geometry\n",
    "end\n",
    "\n",
    "-- entry: Scripts/fix/main.lua\n",
    "local util = require(\"Scripts.fix.util\")\n",
    "local geometry = require(\"Scripts.fix.geometry\")\n",
    "\n",
    "-- not project-local: left untouched for the DCS runtime to provide\n",
    "local has_socket = pcall(require, \"socket\")\n",
    "\n",
    "BUNDLE_PROBE = {\n",
    "  same_util = geometry.util == util,\n",
    "  executions = UTIL_EXECUTIONS,\n",
    "  perimeter = geometry.perimeter(3),\n",
    "  has_socket = has_socket,\n",
    "}\n",
);

fn temp_project(tag: &str, manifest: &str, files: &[(&str, &str)]) -> PathBuf {
    let root = std::env::temp_dir().join(format!("dcs-bundle-cli-{tag}-{}", std::process::id()));
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

fn fixture_project(tag: &str) -> PathBuf {
    temp_project(
        tag,
        FIXTURE_MANIFEST,
        &[
            ("Scripts/fix/main.lua", MAIN_LUA),
            ("Scripts/fix/util.lua", UTIL_LUA),
            ("Scripts/fix/geometry.lua", GEOMETRY_LUA),
        ],
    )
}

fn run_bundle(root: &Path) -> Output {
    Command::new(env!("CARGO_BIN_EXE_dcs-studio-cli"))
        .arg("bundle")
        .arg(root)
        .output()
        .expect("spawn dcs-studio-cli bundle")
}

/// The built dcs-lua-runner, or None (callers skip) — `host_ipc` pattern.
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

#[test]
fn three_module_fixture_matches_the_golden_bundle() {
    let root = fixture_project("golden");

    let output = run_bundle(&root);

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("bundled 2 modules into dist/bundle.lua"),
    );
    let bundled = std::fs::read_to_string(root.join("dist/bundle.lua")).expect("bundle written");
    assert_eq!(bundled, GOLDEN_BUNDLE);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn require_cycle_is_refused_naming_the_cycle() {
    let root = temp_project(
        "cycle",
        "[project]\nname = \"Cycle\"\n\n[build]\nentry = \"main.lua\"\n",
        &[
            ("main.lua", "local a = require(\"a\")\n"),
            ("a.lua", "local b = require(\"b\")\nreturn {}\n"),
            ("b.lua", "local a = require(\"a\")\nreturn {}\n"),
        ],
    );

    let output = run_bundle(&root);

    assert!(!output.status.success(), "a cycle must fail the bundle");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("require cycle: a -> b -> a"),
        "stderr should name the cycle, got: {stderr}"
    );
    assert!(
        !root.join("dist").exists(),
        "no dist output on a refused bundle"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn missing_build_entry_is_an_error_never_a_guess() {
    let root = temp_project("no-entry", "[project]\nname = \"x\"\n", &[]);

    let output = run_bundle(&root);

    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("no [build] entry"),
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// PUC validity oracle: the in-house parser is tolerant by design, so
/// only a real `luac -p` proves the bundle loads under DCS's Lua 5.1.
/// Skips hermetically without `DCS_PUC_LUAC`; CI always sets it.
#[test]
fn bundle_loads_under_puc_lua() {
    let Ok(luac) = std::env::var("DCS_PUC_LUAC") else {
        eprintln!("skipped: set DCS_PUC_LUAC to a PUC Lua 5.1 luac binary");
        return;
    };
    let root = fixture_project("puc");
    let output = run_bundle(&root);
    assert!(output.status.success());

    let status = Command::new(&luac)
        .arg("-p")
        .arg(root.join("dist/bundle.lua"))
        .status()
        .expect("run luac -p");
    assert!(status.success(), "the bundle must load under PUC Lua 5.1");
    let _ = std::fs::remove_dir_all(&root);
}

/// The bundle EXECUTES with require semantics intact, proven under the
/// runner's real Lua 5.1: single execution, module table identity,
/// non-project requires left to fail soft at runtime.
#[test]
fn bundle_executes_under_the_runner_with_require_semantics_intact() {
    let Some(runner) = runner_binary() else {
        eprintln!("SKIP bundle exec: build tools/lua-runner first or set DCS_LUA_RUNNER");
        return;
    };
    let root = fixture_project("exec");
    let output = run_bundle(&root);
    assert!(output.status.success());

    let bundle_path = root.join("dist/bundle.lua").display().to_string().replace('\\', "/");
    std::fs::create_dir_all(root.join("tests")).expect("tests dir");
    std::fs::write(
        root.join("tests/exec.test.lua"),
        format!(
            r#"dofile("{bundle_path}")
test("bundle preserves require semantics", function()
  expect(BUNDLE_PROBE.same_util).toBeTruthy()
  expect(BUNDLE_PROBE.executions).toBe(1)
  expect(BUNDLE_PROBE.perimeter).toBe(12)
  expect(BUNDLE_PROBE.has_socket).toBeFalsy()
end)
"#
        ),
    )
    .expect("write exec spec");

    let output = Command::new(env!("CARGO_BIN_EXE_dcs-studio-cli"))
        .arg("test")
        .arg(&root)
        .env("DCS_LUA_RUNNER", &runner)
        .output()
        .expect("spawn dcs-studio-cli test");

    assert!(
        output.status.success(),
        "bundle execution spec failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let _ = std::fs::remove_dir_all(&root);
}
