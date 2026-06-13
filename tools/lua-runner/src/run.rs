//! One test file, one fresh Lua state (model: `studio::cli::TestRunner`).

use std::path::Path;

use mlua::{Function, Lua, LuaOptions, StdLib, Table};

/// One executed case: full describe-path name; failures carry the
/// matcher's message and the source line it raised at (0 = unknown).
#[derive(Debug, serde::Serialize)]
pub struct TestCase {
    pub name: String,
    pub passed: bool,
    pub message: String,
    pub line: u32,
}

/// One spec file's results. A file that errors outside any test reports
/// a synthetic failed `(file)` case so a broken spec never gates as
/// green-by-absence.
#[derive(Debug, serde::Serialize)]
pub struct FileResult {
    pub path: String,
    pub cases: Vec<TestCase>,
}

const PRELUDE: &str = include_str!("prelude.lua");

/// Run `file` (relative to `root`, or absolute) in a fresh state.
pub fn run_file(root: &Path, file: &str) -> FileResult {
    match try_run(root, file) {
        Ok(cases) => FileResult {
            path: file.to_string(),
            cases,
        },
        // Harness-level failures (unreadable file, broken prelude) are a
        // failed case too, not a silent skip.
        Err(message) => FileResult {
            path: file.to_string(),
            cases: vec![TestCase {
                name: "(file)".to_string(),
                passed: false,
                message,
                line: 0,
            }],
        },
    }
}

fn try_run(root: &Path, file: &str) -> Result<Vec<TestCase>, String> {
    // The debug library is needed for failure line numbers
    // (debug.traceback in the prelude's error handler); mlua gates it
    // behind unsafe_new_with because Lua code could break Rust invariants
    // through it. Acceptable here: this binary only ever runs the
    // developer's own test files, locally, with no embedder state to
    // corrupt — the whole process is the sandbox.
    let lua = unsafe { Lua::unsafe_new_with(StdLib::ALL_SAFE | StdLib::DEBUG, LuaOptions::new()) };

    // require() resolves project modules against the project root only —
    // hermetic by construction, no system package.path leaks in.
    let package: Table = lua
        .globals()
        .get("package")
        .map_err(|e| format!("package table: {e}"))?;
    let root_display = root.display().to_string();
    package
        .set(
            "path",
            format!("{root_display}/?.lua;{root_display}/?/init.lua"),
        )
        .map_err(|e| format!("package.path: {e}"))?;

    let prelude: Table = lua
        .load(PRELUDE)
        .set_name("@dcs-lua-runner/prelude.lua")
        .eval()
        .map_err(|e| format!("prelude: {e}"))?;

    let path = root.join(file);
    let source =
        std::fs::read_to_string(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;

    // "@<file>" is Lua's file-chunk convention: error positions render as
    // "<file>:<line>:", which the prelude's failure parser picks up.
    let chunk_outcome = lua.load(&source).set_name(format!("@{file}")).exec();

    let finalize: Function = prelude
        .get("finalize")
        .map_err(|e| format!("prelude finalize: {e}"))?;
    let collected: Table = finalize
        .call(())
        .map_err(|e| format!("collecting results: {e}"))?;

    let mut cases = Vec::new();
    for entry in collected.sequence_values::<Table>() {
        let case = entry.map_err(|e| format!("result entry: {e}"))?;
        cases.push(TestCase {
            name: case.get("name").unwrap_or_else(|_| "(unnamed)".to_string()),
            passed: case.get("passed").unwrap_or(false),
            message: case.get("message").unwrap_or_default(),
            line: case.get("line").unwrap_or(0),
        });
    }

    // A top-level error (after any tests that did run) is its own failed
    // case — tests that ran still report.
    if let Err(error) = chunk_outcome {
        cases.push(TestCase {
            name: "(file)".to_string(),
            passed: false,
            message: error.to_string(),
            line: 0,
        });
    }

    Ok(cases)
}
