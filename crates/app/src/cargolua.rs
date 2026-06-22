// CargoLua task runner (model studio::cargolua::CargoLuaTasks): the desktop-app
// face over lua-cargo's resolver and bundler — the same toolchain the CLI uses,
// run in-process. `lua_cargo_fetch` vendors the project's git dependencies into
// `.lua-cargo/deps` and writes the lock; `lua_cargo_bundle` amalgamates its
// `[[bundle]]` targets. Both run on a worker thread (the resolver shells out to
// git, the bundler walks the require graph — neither must block the UI thread),
// stream progress line-by-line to the Dependencies panel as `cargolua://output`
// events, and report the outcome as `cargolua://done`. One task at a time per
// app — the same single-flight busy mutex the build runner (build.rs) uses, so
// two runs can never interleave their output or race the vendor cache.

use std::path::Path;
use std::sync::{Mutex, PoisonError};

use lua_cargo::{BundleReport, CargoError, ResolveReport};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// One lua-cargo task at a time per app: `true` while a fetch or bundle runs.
#[derive(Default)]
pub struct CargoLuaState(Mutex<bool>);

/// `cargolua://done` payload (model `CargoLuaOutcome`): which task ran, whether
/// it succeeded, and a one-line summary for the panel status. On failure the
/// summary is the `CargoError` message — the panel surfaces it verbatim.
#[derive(Clone, Serialize)]
struct CargoLuaDone {
    task: &'static str,
    succeeded: bool,
    summary: String,
}

/// Fetch the project's dependencies (model `CargoLuaTasks.Fetch`): vendor each
/// git dependency into `.lua-cargo/deps` and write the lock. Returns once the
/// worker is spawned; output and completion arrive as events. The frontend
/// re-indexes on the `cargolua://done` success so the new modules light up
/// without reopening the project (model `FetchReindexesWithoutReopen`).
#[tauri::command]
pub fn lua_cargo_fetch(
    app: AppHandle,
    state: State<'_, CargoLuaState>,
    root: String,
) -> Result<(), String> {
    begin(&state)?;
    run("fetch", app, root, |root, emit| {
        Ok(fetch_summary(&lua_cargo::resolve(root)?, emit))
    });
    Ok(())
}

/// Bundle the project's `[[bundle]]` targets (model `CargoLuaTasks.Bundle`):
/// amalgamate each entry's require graph into one self-contained file. Returns
/// once the worker is spawned; output and completion arrive as events.
#[tauri::command]
pub fn lua_cargo_bundle(
    app: AppHandle,
    state: State<'_, CargoLuaState>,
    root: String,
) -> Result<(), String> {
    begin(&state)?;
    run("bundle", app, root, |root, emit| {
        Ok(bundle_summary(&lua_cargo::bundle(root)?, emit))
    });
    Ok(())
}

/// Claim the single-task slot, or report it busy (model `OneCargoLuaTaskAtATime`).
/// Poison-tolerant like the build runner's guard so a panicked worker thread
/// never wedges future tasks.
fn begin(state: &State<'_, CargoLuaState>) -> Result<(), String> {
    let mut busy = state.0.lock().unwrap_or_else(PoisonError::into_inner);
    if *busy {
        return Err("a dependency task is already running".to_string());
    }
    *busy = true;
    Ok(())
}

/// Run `work` on a worker thread, then report the outcome on `cargolua://done`
/// and release the busy slot. `work` streams its progress through the supplied
/// emitter and returns the panel summary on success, or a `CargoError` whose
/// message becomes the failure summary.
fn run<F>(task: &'static str, app: AppHandle, root: String, work: F)
where
    F: FnOnce(&Path, &dyn Fn(String)) -> Result<String, CargoError> + Send + 'static,
{
    std::thread::spawn(move || {
        let emitter = app.clone();
        let emit = move |line: String| {
            let _ = emitter.emit("cargolua://output", line);
        };
        let (succeeded, summary) = match work(Path::new(&root), &emit) {
            Ok(summary) => (true, summary),
            Err(error) => (false, error.to_string()),
        };
        clear_busy(&app);
        let _ = app.emit(
            "cargolua://done",
            CargoLuaDone {
                task,
                succeeded,
                summary,
            },
        );
    });
}

/// Stream each resolved dependency (`name = owner/repo @ <short-sha>`) to the
/// panel and return the fetch summary.
fn fetch_summary(report: &ResolveReport, emit: &dyn Fn(String)) -> String {
    for entry in &report.entries {
        emit(format!(
            "{} = {} @ {}",
            entry.name,
            entry.github,
            short_rev(&entry.rev)
        ));
    }
    match report.entries.len() {
        0 => "no dependencies to fetch".to_string(),
        1 => "1 dependency fetched".to_string(),
        n => format!("{n} dependencies fetched"),
    }
}

/// Stream the emitted file, each amalgamated module, and each unresolved-require
/// warning to the panel, and return the bundle summary.
fn bundle_summary(report: &BundleReport, emit: &dyn Fn(String)) -> String {
    if report.modules.is_empty() && report.output.as_os_str().is_empty() {
        return "no [[bundle]] targets".to_string();
    }
    emit(format!("wrote {}", report.output.display()));
    for module in &report.modules {
        emit(format!("  + {module}"));
    }
    for warning in &report.warnings {
        emit(format!("  ! {warning}"));
    }
    let modules = plural(report.modules.len(), "module");
    if report.warnings.is_empty() {
        format!("bundle written ({modules})")
    } else {
        format!(
            "bundle written ({modules}, {})",
            plural(report.warnings.len(), "warning")
        )
    }
}

/// The first 8 characters of a 40-char HEAD sha, for a compact panel line.
fn short_rev(rev: &str) -> &str {
    rev.get(..8).unwrap_or(rev)
}

/// `"1 module"` / `"3 modules"` — count with the singular/plural noun.
fn plural(count: usize, noun: &str) -> String {
    if count == 1 {
        format!("{count} {noun}")
    } else {
        format!("{count} {noun}s")
    }
}

/// Release the busy slot. Poison-tolerant: even if the worker panicked, the flag
/// must come down or no task ever runs again.
fn clear_busy(app: &AppHandle) {
    use tauri::Manager as _;
    if let Some(state) = app.try_state::<CargoLuaState>() {
        *state.0.lock().unwrap_or_else(PoisonError::into_inner) = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Mutex;

    fn entry(name: &str, github: &str, rev: &str) -> lua_cargo::LockEntry {
        lua_cargo::LockEntry {
            name: name.to_string(),
            github: github.to_string(),
            selector: String::new(),
            rev: rev.to_string(),
        }
    }

    #[test]
    fn fetch_summary_lists_each_dep_and_counts() {
        let report = ResolveReport {
            entries: vec![
                entry(
                    "moose",
                    "FlightControl-Master/MOOSE",
                    "0123456789abcdef0123456789abcdef01234567",
                ),
                entry("util", "owner/util", "abcdef01"),
            ],
            vendor_dir: PathBuf::from("/p/.lua-cargo/deps"),
        };
        let sink = Mutex::new(Vec::<String>::new());
        let emit = |line: String| sink.lock().unwrap().push(line);
        assert_eq!(fetch_summary(&report, &emit), "2 dependencies fetched");
        let lines = sink.lock().unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "moose = FlightControl-Master/MOOSE @ 01234567");
        assert_eq!(lines[1], "util = owner/util @ abcdef01");
    }

    #[test]
    fn fetch_summary_handles_no_deps() {
        let report = ResolveReport {
            entries: vec![],
            vendor_dir: PathBuf::from("/p/.lua-cargo/deps"),
        };
        let sink = Mutex::new(Vec::<String>::new());
        let emit = |line: String| sink.lock().unwrap().push(line);
        assert_eq!(fetch_summary(&report, &emit), "no dependencies to fetch");
        assert!(sink.lock().unwrap().is_empty());
    }

    #[test]
    fn bundle_summary_lists_modules_and_warnings() {
        let report = BundleReport {
            output: PathBuf::from("/p/dist/main.lua"),
            modules: vec!["main".to_string(), "a.b".to_string()],
            warnings: vec!["unresolved require \"socket\"".to_string()],
        };
        let sink = Mutex::new(Vec::<String>::new());
        let emit = |line: String| sink.lock().unwrap().push(line);
        assert_eq!(
            bundle_summary(&report, &emit),
            "bundle written (2 modules, 1 warning)"
        );
        let lines = sink.lock().unwrap();
        assert_eq!(lines[0], "wrote /p/dist/main.lua");
        assert_eq!(lines[1], "  + main");
        assert_eq!(lines[2], "  + a.b");
        assert_eq!(lines[3], "  ! unresolved require \"socket\"");
    }

    #[test]
    fn bundle_summary_handles_empty_report() {
        let report = BundleReport {
            output: PathBuf::new(),
            modules: vec![],
            warnings: vec![],
        };
        let emit = |_line: String| {};
        assert_eq!(bundle_summary(&report, &emit), "no [[bundle]] targets");
    }

    #[test]
    fn short_rev_truncates_and_tolerates_short() {
        assert_eq!(short_rev("0123456789abcdef"), "01234567");
        assert_eq!(short_rev("abc"), "abc");
    }
}
