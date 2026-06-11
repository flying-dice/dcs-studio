//! dcs-lua-runner — runs mod Lua unit tests outside DCS (issue #9;
//! model: `studio::cli::TestRunner`).
//!
//! Reads a JSON spec — `{ "root": "<project root>", "files": ["tests/x.test.lua", ...] }`
//! — from the file named by argv[1], or from stdin when no argument is
//! given. Every file runs in a FRESH Lua 5.1 state (mlua `vendored`,
//! PUC 5.1 compiled from source) with the describe/test/expect harness
//! and the recording DCS stubs (`src/prelude.lua` documents the full
//! surface). Emits `{ "files": [ { "path", "cases": [...] } ] }` on
//! stdout.
//!
//! Exit code: 0 whenever the spec ran to completion — failing TESTS are
//! data in the results, and the caller (dcs-studio-cli test) gates on
//! them; nonzero only when the runner itself could not run (bad spec,
//! unreadable input).

mod run;

use std::io::Read;
use std::process::ExitCode;

#[derive(serde::Deserialize)]
struct Spec {
    root: std::path::PathBuf,
    files: Vec<String>,
}

#[derive(serde::Serialize)]
struct Output {
    files: Vec<run::FileResult>,
}

fn main() -> ExitCode {
    let text = if let Some(path) = std::env::args().nth(1) {
        match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) => {
                eprintln!("dcs-lua-runner: reading spec {path}: {error}");
                return ExitCode::FAILURE;
            }
        }
    } else {
        let mut text = String::new();
        if let Err(error) = std::io::stdin().read_to_string(&mut text) {
            eprintln!("dcs-lua-runner: reading spec from stdin: {error}");
            return ExitCode::FAILURE;
        }
        text
    };

    let spec: Spec = match serde_json::from_str(&text) {
        Ok(spec) => spec,
        Err(error) => {
            eprintln!("dcs-lua-runner: parsing spec: {error}");
            return ExitCode::FAILURE;
        }
    };

    let files = spec
        .files
        .iter()
        .map(|file| run::run_file(&spec.root, file))
        .collect();

    let rendered = serde_json::to_string(&Output { files })
        .expect("results are plain strings/numbers/bools and always serialise");
    println!("{rendered}");
    ExitCode::SUCCESS
}
