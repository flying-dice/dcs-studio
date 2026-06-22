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
        Ok(fetch_summary(&lua_cargo::resolve_with_progress(root, emit)?))
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
        Ok(bundle_summary(&lua_cargo::bundle_with_progress(root, emit)?))
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
/// message becomes the failure summary. A `DoneGuard` makes "done is always
/// emitted" hold by construction: if `work` panics (it runs the resolver/bundler
/// in-process, unlike `build.rs` which only pumps a subprocess), the guard still
/// releases the slot and emits a failure `done`, so the panel never wedges.
fn run<F>(task: &'static str, app: AppHandle, root: String, work: F)
where
    F: FnOnce(&Path, &dyn Fn(String)) -> Result<String, CargoError> + Send + 'static,
{
    std::thread::spawn(move || {
        // Armed until the normal path below runs; a panic in `work` unwinds past
        // it, and Drop releases the slot + emits a failure `done`.
        let mut guard = DoneGuard {
            app: app.clone(),
            task,
            armed: true,
        };
        let emitter = app.clone();
        let emit = move |line: String| {
            let _ = emitter.emit("cargolua://output", line);
        };
        let (succeeded, summary) = match work(Path::new(&root), &emit) {
            Ok(summary) => (true, summary),
            Err(error) => (false, error.to_string()),
        };
        guard.armed = false;
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

/// Releases the busy slot and emits a failure `cargolua://done` if dropped while
/// still armed — i.e. the worker panicked before its normal completion path ran.
/// The normal path disarms it and emits the true outcome itself, so the guard is
/// a no-op then. Without it a panic would skip both, wedging the busy flag (every
/// later task "already running") and the panel (`running` stuck forever).
struct DoneGuard {
    app: AppHandle,
    task: &'static str,
    armed: bool,
}

impl Drop for DoneGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        clear_busy(&self.app);
        let _ = self.app.emit(
            "cargolua://done",
            CargoLuaDone {
                task: self.task,
                succeeded: false,
                summary: "dependency task panicked".to_string(),
            },
        );
    }
}

/// The one-line fetch summary for the panel status. The per-dependency lines
/// (`name = owner/repo @ <short-sha>`) are streamed live by
/// `lua_cargo::resolve_with_progress` as each is vendored.
fn fetch_summary(report: &ResolveReport) -> String {
    match report.entries.len() {
        0 => "no dependencies to fetch".to_string(),
        1 => "1 dependency fetched".to_string(),
        n => format!("{n} dependencies fetched"),
    }
}

/// The one-line bundle summary for the panel status. The written file, each
/// amalgamated module, and each warning are streamed live by
/// `lua_cargo::bundle_with_progress`. With no `[[bundle]]` targets the bundler
/// amalgamates nothing, so `modules` is empty — every real target contributes
/// at least its entry module, making an empty list the unambiguous no-op signal
/// (the default `output` is `<root>/dist`, never empty, so it can't be one).
fn bundle_summary(report: &BundleReport) -> String {
    if report.modules.is_empty() {
        return "no [[bundle]] targets".to_string();
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

    fn entry(name: &str, github: &str, rev: &str) -> lua_cargo::LockEntry {
        lua_cargo::LockEntry {
            name: name.to_string(),
            github: github.to_string(),
            selector: String::new(),
            rev: rev.to_string(),
        }
    }

    #[test]
    fn fetch_summary_counts_dependencies() {
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
        assert_eq!(fetch_summary(&report), "2 dependencies fetched");
    }

    #[test]
    fn fetch_summary_uses_singular_for_one_dep() {
        let report = ResolveReport {
            entries: vec![entry("util", "owner/util", "abcdef01")],
            vendor_dir: PathBuf::from("/p/.lua-cargo/deps"),
        };
        assert_eq!(fetch_summary(&report), "1 dependency fetched");
    }

    #[test]
    fn fetch_summary_handles_no_deps() {
        let report = ResolveReport {
            entries: vec![],
            vendor_dir: PathBuf::from("/p/.lua-cargo/deps"),
        };
        assert_eq!(fetch_summary(&report), "no dependencies to fetch");
    }

    #[test]
    fn bundle_summary_counts_modules_and_warnings() {
        let report = BundleReport {
            output: PathBuf::from("/p/dist/main.lua"),
            modules: vec!["main".to_string(), "a.b".to_string()],
            warnings: vec!["unresolved require \"socket\"".to_string()],
        };
        assert_eq!(
            bundle_summary(&report),
            "bundle written (2 modules, 1 warning)"
        );
    }

    #[test]
    fn bundle_summary_one_module_no_warnings() {
        let report = BundleReport {
            output: PathBuf::from("/p/dist/out.lua"),
            modules: vec!["main".to_string()],
            warnings: vec![],
        };
        assert_eq!(bundle_summary(&report), "bundle written (1 module)");
    }

    #[test]
    fn bundle_summary_handles_no_targets() {
        // The shape `bundle()` actually returns with no [[bundle]] targets: a
        // non-empty default output (`<root>/dist`) and zero modules. The empty
        // module list alone is the no-op signal — a real target always
        // contributes at least its entry module, and the seeded output is never
        // empty (the round-1 test fabricated an empty output `bundle()` never emits).
        let report = BundleReport {
            output: PathBuf::from("/p/dist"),
            modules: vec![],
            warnings: vec![],
        };
        assert_eq!(bundle_summary(&report), "no [[bundle]] targets");
    }
}
