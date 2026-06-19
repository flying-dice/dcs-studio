#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing, clippy::panic, clippy::print_stdout, clippy::print_stderr)] // integration test crate: test code, exempt from the production safety lints

//! Conformance harness: globs `CONFORMANCE/<layer>/` and diffs rendered
//! output against the hand-written goldens (CONFORMANCE/README.md).

use std::fs;
use std::path::PathBuf;

fn conformance_dir(layer: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../CONFORMANCE")
        .join(layer)
}

/// Normalise checkout line endings so goldens are byte-comparable.
fn read_normalised(path: &PathBuf) -> String {
    fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("reading {}: {e}", path.display()))
        .replace("\r\n", "\n")
}

#[test]
fn syntax_accept_cases_parse_clean() {
    let dir = conformance_dir("syntax");
    let mut cases = 0;
    for entry in fs::read_dir(&dir).expect("CONFORMANCE/syntax exists") {
        let path = entry.expect("dir entry").path();
        if path.extension().is_none_or(|e| e != "lua") {
            continue;
        }
        cases += 1;
        let source = read_normalised(&path);
        let parsed = dcs_lua_syntax::parser::parse(&source);
        assert!(
            parsed.diagnostics.is_empty(),
            "{}: accept case produced diagnostics: {:?}",
            path.display(),
            parsed.diagnostics
        );
    }
    assert!(cases > 0, "no syntax accept cases in {}", dir.display());
}

#[test]
fn syntax_reject_cases_diagnose_and_still_yield_a_tree() {
    let dir = conformance_dir("syntax");
    let mut cases = 0;
    for entry in fs::read_dir(&dir).expect("CONFORMANCE/syntax exists") {
        let path = entry.expect("dir entry").path();
        if path.extension().is_none_or(|e| e != "reject") {
            continue;
        }
        cases += 1;
        let expected_path = path.with_extension("reject.expected");
        let expected = read_normalised(&expected_path);
        assert!(
            !expected.trim().is_empty(),
            "{} must state an error category",
            expected_path.display()
        );
        let source = read_normalised(&path);
        let parsed = dcs_lua_syntax::parser::parse(&source);
        assert!(
            parsed
                .diagnostics
                .iter()
                .any(|d| d.code.starts_with("LUA-E1")),
            "{}: expected a LUA-E1xx diagnostic, got {:?}",
            path.display(),
            parsed.diagnostics
        );
        // The category prose must describe a diagnostic actually emitted.
        assert!(
            parsed.diagnostics.iter().any(
                |d| d.message.contains(expected.trim()) || expected.trim().contains(&d.message)
            ),
            "{}: no diagnostic matches category '{}'; got {:?}",
            path.display(),
            expected.trim(),
            parsed.diagnostics
        );
    }
    assert!(cases > 0, "no syntax reject cases in {}", dir.display());
}

#[test]
fn lexical_goldens() {
    let dir = conformance_dir("lexical");
    let mut cases = 0;
    let mut failures = Vec::new();
    for entry in fs::read_dir(&dir).expect("CONFORMANCE/lexical exists") {
        let path = entry.expect("dir entry").path();
        if path.extension().is_none_or(|e| e != "lua") {
            continue;
        }
        cases += 1;
        let source = read_normalised(&path);
        let golden = read_normalised(&path.with_extension("tokens"));
        let rendered = dcs_lua_syntax::lexer::render_tokens(&source);
        if rendered != golden {
            failures.push(format!(
                "{}:\n--- expected ---\n{golden}\n--- got ---\n{rendered}",
                path.file_name().unwrap().to_string_lossy()
            ));
        }
    }
    assert!(cases > 0, "no lexical cases found in {}", dir.display());
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
