//! `dcs-studio-cli fmt` — format Lua sources in place, or `--check` them
//! for CI (model: `fmt::Fmt`; house style decisions/006).
//!
//! Exit-code contract: `--check` exits 1 when any file would change,
//! 0 otherwise. Files that do not parse are reported on stderr and
//! skipped in both modes without affecting the exit code — surfacing
//! syntax errors is `check`'s job, and gating fmt on them would make a
//! broken file block formatting the rest. A nonexistent path is an
//! error, never a no-op. A semantic-guard trip (decisions/006) warns
//! loudly on stderr, leaves the file unchanged, and the walk continues
//! — but the run exits FAILURE in both modes (in-place and `--check`):
//! a trip is an internal formatter bug leaving a file non-canonical,
//! and a gate built on fmt must go red, not green.
//! In-place writes go through a same-directory temp file renamed over
//! the original, so a crash mid-write can never truncate a script; a
//! file is reported on stdout only after its write succeeded.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use dcs_lua_fmt::FormatConfig;

pub fn run(paths: &[PathBuf], check: bool) -> ExitCode {
    let mut would_change = 0usize;
    let mut checked = 0usize;
    let mut failed = false;

    for path in paths {
        let files = if path.is_dir() {
            dcs_studio_project::sources::collect(path)
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
            match formatted_with_test_hook(&text, &config) {
                Ok(formatted) if formatted.guard_tripped => {
                    eprintln!(
                        "fmt: {file}: internal formatter guard tripped; \
                         file left unchanged — please report this file"
                    );
                    // A trip is a formatter bug leaving the file
                    // non-canonical: fail the run (both modes), but keep
                    // walking so every affected file gets named.
                    failed = true;
                }
                Ok(formatted) if formatted.text == text => {}
                Ok(formatted) => {
                    would_change += 1;
                    if check {
                        println!("{file}");
                    } else {
                        match write_atomic(Path::new(&file), &formatted.text) {
                            Ok(()) => println!("{file}"),
                            Err(error) => {
                                eprintln!("fmt: writing {file}: {error}");
                                failed = true;
                            }
                        }
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

/// [`dcs_lua_fmt::format`], plus a debug-build-only test hook: a real
/// guard trip requires a formatter bug, so the CLI's warn-and-continue
/// arm is otherwise untestable. With `DCS_STUDIO_FMT_FORCE_GUARD_TRIP`
/// set, a debug binary reports every file as tripped (input unchanged) —
/// release builds compile the hook out.
fn formatted_with_test_hook(
    text: &str,
    config: &FormatConfig,
) -> Result<dcs_lua_fmt::Formatted, Vec<dcs_lua_fmt::Diagnostic>> {
    let result = dcs_lua_fmt::format(text, config);
    if cfg!(debug_assertions)
        && result.is_ok()
        && std::env::var_os("DCS_STUDIO_FMT_FORCE_GUARD_TRIP").is_some()
    {
        return Ok(dcs_lua_fmt::Formatted {
            text: text.to_string(),
            guard_tripped: true,
        });
    }
    result
}

/// Write via a sibling temp file renamed over the original, so a crash or
/// full disk mid-write can never leave a mission script truncated. The
/// temp file lives in the same directory (same volume — `rename` stays
/// atomic) and is cleaned up if the rename fails.
fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    let mut tmp_name = path.as_os_str().to_os_string();
    tmp_name.push(".fmt-tmp");
    let tmp = PathBuf::from(tmp_name);
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
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
