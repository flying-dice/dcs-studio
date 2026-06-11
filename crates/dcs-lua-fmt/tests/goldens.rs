//! Formatter conformance harness: `CONFORMANCE/format/<case>.lua` must
//! format (default config) to the hand-written `<case>.formatted.lua`,
//! and every expected output must be a fixed point of the formatter
//! (SPEC.md §7, CONFORMANCE/format/README.md). With `DCS_PUC_LUAC` set
//! (path to a real PUC Lua 5.1 `luac`), every expected output must also
//! load under PUC Lua — the SPEC's validity claim, checked for real.

use std::fs;
use std::path::PathBuf;

use dcs_lua_fmt::FormatConfig;

fn format_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../CONFORMANCE/format")
}

/// Normalise checkout line endings so goldens are byte-comparable.
fn read_normalised(path: &PathBuf) -> String {
    fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("reading {}: {e}", path.display()))
        .replace("\r\n", "\n")
}

fn cases() -> Vec<(PathBuf, String, String)> {
    let dir = format_dir();
    let mut cases = Vec::new();
    for entry in fs::read_dir(&dir).expect("CONFORMANCE/format exists") {
        let path = entry.expect("dir entry").path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let Some(case) = name.strip_suffix(".lua") else {
            continue;
        };
        if case.ends_with(".formatted") {
            continue;
        }
        let expected_path = dir.join(format!("{case}.formatted.lua"));
        let input = read_normalised(&path);
        let expected = read_normalised(&expected_path);
        cases.push((path, input, expected));
    }
    assert!(!cases.is_empty(), "no format cases in {}", dir.display());
    cases
}

#[test]
fn goldens_format_as_written() {
    let config = FormatConfig::default();
    let mut failures = Vec::new();
    for (path, input, expected) in cases() {
        let got = dcs_lua_fmt::format(&input, &config)
            .unwrap_or_else(|d| panic!("{}: golden input must parse: {d:?}", path.display()));
        assert!(
            !got.guard_tripped,
            "{}: semantic guard tripped",
            path.display()
        );
        if got.text != expected {
            failures.push(format!(
                "{}:\n--- expected ---\n{expected}\n--- got ---\n{}",
                path.file_name().unwrap().to_string_lossy(),
                got.text
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn golden_outputs_are_fixed_points() {
    let config = FormatConfig::default();
    for (path, _, expected) in cases() {
        let got = dcs_lua_fmt::format(&expected, &config)
            .unwrap_or_else(|d| panic!("{}: expected output must parse: {d:?}", path.display()));
        assert_eq!(
            got.text,
            expected,
            "{}: expected output is not a fixed point",
            path.display()
        );
    }
}

/// PUC validity (SPEC.md §7): every golden's expected output must load
/// under real PUC Lua 5.1. Runs only when `DCS_PUC_LUAC` names a `luac`
/// binary (e.g. `C:\lua\lua-5.1.5_Win64_bin\luac5.1.exe`) so the default
/// suite stays hermetic.
#[test]
fn golden_outputs_load_under_puc_lua() {
    let Ok(luac) = std::env::var("DCS_PUC_LUAC") else {
        eprintln!("skipped: set DCS_PUC_LUAC to a PUC Lua 5.1 luac binary");
        return;
    };
    let dir = format_dir();
    let mut checked = 0;
    for entry in fs::read_dir(&dir).expect("CONFORMANCE/format exists") {
        let path = entry.expect("dir entry").path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if !name.ends_with(".formatted.lua") {
            continue;
        }
        let output = std::process::Command::new(&luac)
            .arg("-p")
            .arg(&path)
            .output()
            .unwrap_or_else(|e| panic!("spawning {luac}: {e}"));
        assert!(
            output.status.success(),
            "{}: PUC luac rejected the expected output:\n{}",
            path.display(),
            String::from_utf8_lossy(&output.stderr)
        );
        checked += 1;
    }
    assert!(checked > 0, "no .formatted.lua goldens checked");
}
