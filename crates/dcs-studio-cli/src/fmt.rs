//! `dcs-studio-cli fmt` — format Lua sources in place, or `--check` them
//! for CI (model: `fmt::Fmt`; house style decisions/006).
//!
//! Exit-code contract: `--check` exits 1 when any file would change,
//! 0 otherwise. Files that do not parse are reported on stderr and
//! skipped in both modes without affecting the exit code — surfacing
//! syntax errors is `check`'s job, and gating fmt on them would make a
//! broken file block formatting the rest. A nonexistent path is an
//! error, never a no-op.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use dcs_lua_fmt::FormatConfig;

pub fn run(paths: &[PathBuf], check: bool) -> ExitCode {
    let mut would_change = 0usize;
    let mut checked = 0usize;
    let mut failed = false;

    for path in paths {
        let files = if path.is_dir() {
            crate::sources::collect(path)
        } else if path.is_file() {
            match std::fs::read_to_string(path) {
                Ok(text) => vec![(path.display().to_string(), text)],
                Err(error) => {
                    eprintln!("fmt: reading {}: {error}", path.display());
                    failed = true;
                    continue;
                }
            }
        } else {
            eprintln!("fmt: '{}' does not exist", path.display());
            failed = true;
            continue;
        };
        let config = config_for(path);
        for (file, text) in files {
            checked += 1;
            match dcs_lua_fmt::format(&text, &config) {
                Ok(formatted) if formatted == text => {}
                Ok(formatted) => {
                    would_change += 1;
                    println!("{file}");
                    if !check
                        && let Err(error) = std::fs::write(&file, formatted)
                    {
                        eprintln!("fmt: writing {file}: {error}");
                        failed = true;
                    }
                }
                Err(diagnostics) => {
                    // Parse errors are `check`'s job: report, skip, move on.
                    let detail = diagnostics
                        .first()
                        .map(|d| format!("{} {}", d.code, d.message))
                        .unwrap_or_default();
                    eprintln!("fmt: skipped {file}: does not parse ({detail})");
                }
            }
        }
    }

    if check {
        println!("{checked} file(s) checked, {would_change} would be reformatted");
    } else {
        println!("{checked} file(s) checked, {would_change} reformatted");
    }
    if failed || (check && would_change > 0) {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

/// The `[format]` config governing `path`: the nearest `dcs-studio.toml`
/// walking up from the path (the directory itself for a dir, the parent
/// for a file). Absent or unreadable manifest → house defaults; a present
/// but invalid manifest is reported and falls back to defaults.
fn config_for(path: &Path) -> FormatConfig {
    let start = if path.is_dir() {
        path
    } else {
        path.parent().unwrap_or(path)
    };
    for dir in start.ancestors() {
        if !dir.join("dcs-studio.toml").is_file() {
            continue;
        }
        return match dcs_studio_project::manifest::load(dir) {
            Ok(manifest) => manifest.format,
            Err(error) => {
                eprintln!("fmt: {error}; using default format config");
                FormatConfig::default()
            }
        };
    }
    FormatConfig::default()
}
