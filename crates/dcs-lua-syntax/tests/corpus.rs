#![allow(clippy::unwrap_used, clippy::expect_used, clippy::indexing_slicing, clippy::panic, clippy::print_stdout, clippy::print_stderr)] // integration test crate: test code, exempt from the production safety lints

//! Real-world corpus gate (CLAUDE.md "Robustness gates"): every file in
//! `testdata/` parses panic-free, diagnostic-free, inside the time budget.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Generous for debug builds; the gate catches hangs and quadratic blowups,
/// not micro-regressions.
const BUDGET: Duration = Duration::from_secs(10);

#[test]
fn corpus_parses_clean_within_budget() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../testdata");
    let mut checked = 0;
    for entry in fs::read_dir(&dir).expect("testdata exists") {
        let path = entry.expect("dir entry").path();
        if path.extension().is_none_or(|e| e != "lua") {
            continue;
        }
        checked += 1;
        let source = fs::read_to_string(&path).expect("corpus file is UTF-8");
        let started = Instant::now();
        let parsed = dcs_lua_syntax::parser::parse(&source);
        let elapsed = started.elapsed();
        assert!(
            elapsed < BUDGET,
            "{} took {elapsed:?} (budget {BUDGET:?})",
            path.display()
        );
        assert!(
            parsed.diagnostics.is_empty(),
            "{}: expected clean parse, got {} diagnostics; first: {:?}",
            path.display(),
            parsed.diagnostics.len(),
            parsed.diagnostics.first()
        );
    }
    assert!(checked > 0, "no corpus files in {}", dir.display());
}
