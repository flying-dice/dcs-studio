//! Workspace filesystem watcher (issue #40). A recursive `notify` watch over the
//! open project root relays DEBOUNCED change events to the frontend as
//! `fs://changed` (the list of affected paths), so the file tree refreshes
//! instantly — not on a poll — and open editor buffers can reconcile with disk.
//! Build/VCS/dependency noise dirs are filtered so a `cargo build` or a `git`
//! op can't flood the UI. One project is watched at a time; opening another (or
//! closing) replaces/drops the watch via the managed [`WatchState`].

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Holds the active debouncer; dropping it stops the watch. Default = not watching.
#[derive(Default)]
pub struct WatchState {
    debouncer: Mutex<Option<Debouncer<RecommendedWatcher>>>,
}

/// How long bursts collapse — a save or a git checkout fires many raw events.
const DEBOUNCE: Duration = Duration::from_millis(300);

/// Path segments whose changes are noise for the workspace view (build outputs,
/// VCS internals, dependency/cache trees). A change anywhere under one is dropped.
const IGNORED_SEGMENTS: &[&str] = &[
    ".git",
    "target",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".lua-cargo",
    ".svelte-kit",
    ".cargo",
    ".cache",
];

/// Whether a changed path is build/VCS noise — judged on the part BELOW the
/// watch root only. Matching the absolute path would wrongly kill the entire
/// watch when the project itself lives under a noise-named ancestor (e.g. a repo
/// checked out into `…/build/…` or `~/.cache/…`).
fn is_ignored(path: &str, root: &str) -> bool {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.split(['/', '\\'])
        .any(|seg| IGNORED_SEGMENTS.contains(&seg))
}

/// Normalize a watched path so it matches the identity the file tree emits:
/// strip the Windows `\\?\` verbatim prefix `notify` can attach, so the
/// frontend's `canonicalPath` lookup against open buffers never silently misses.
fn normalize(path: &str) -> String {
    path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
}

/// Start (or restart) watching `path` recursively, replacing any prior watch.
#[tauri::command]
pub fn watch_start(
    path: String,
    app: AppHandle,
    state: tauri::State<'_, WatchState>,
) -> Result<(), String> {
    let root = normalize(&path);
    let mut debouncer = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let paths: Vec<String> = events
            .into_iter()
            .map(|e| normalize(&e.path.to_string_lossy()))
            .filter(|p| !is_ignored(p, &root))
            .collect();
        if !paths.is_empty() {
            let _ = app.emit("fs://changed", &paths);
        }
    })
    .map_err(|e| format!("watcher init: {e}"))?;
    debouncer
        .watcher()
        .watch(Path::new(&path), RecursiveMode::Recursive)
        .map_err(|e| format!("watch {path}: {e}"))?;
    // Swap in the new debouncer; the old one (if any) drops here and stops.
    *state
        .debouncer
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(debouncer);
    Ok(())
}

/// Stop watching (drops the debouncer). Idempotent — safe when not watching.
#[tauri::command]
pub fn watch_stop(state: tauri::State<'_, WatchState>) {
    *state
        .debouncer
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

#[cfg(test)]
mod tests {
    use super::is_ignored;

    #[test]
    fn ignores_build_and_vcs_noise_below_the_root() {
        let root = r"C:\proj";
        assert!(is_ignored(r"C:\proj\target\debug\x.rs", root));
        assert!(is_ignored(r"C:\proj\.git\index", root));
        assert!(is_ignored(r"C:\proj\node_modules\pkg\i.js", root));
        assert!(is_ignored("/proj/.lua-cargo/deps/moose/m.lua", "/proj"));
    }

    #[test]
    fn keeps_real_workspace_files() {
        let root = r"C:\proj";
        assert!(!is_ignored(r"C:\proj\src\main.lua", root));
        assert!(!is_ignored("/proj/mission/unit-db.tsv", "/proj"));
        // A file merely NAMED like a noise dir (not a path segment) is kept.
        assert!(!is_ignored(r"C:\proj\src\target-list.lua", root));
    }

    #[test]
    fn a_noise_named_ancestor_of_the_root_does_not_kill_the_watch() {
        // The PROJECT lives under a `build/` (or `.cache/`) ancestor — only the
        // part BELOW the watch root is judged, so real files are still emitted.
        let root = r"C:\work\build\my-mod";
        assert!(!is_ignored(r"C:\work\build\my-mod\src\main.lua", root), "real file kept");
        assert!(!is_ignored(r"C:\work\build\my-mod\mission.lua", root));
        // Noise BELOW the root is still ignored.
        assert!(is_ignored(r"C:\work\build\my-mod\target\x", root));
        // Unix flavour.
        assert!(!is_ignored("/home/u/.cache/proj/src/a.lua", "/home/u/.cache/proj"));
    }

    #[test]
    fn normalize_strips_the_windows_verbatim_prefix() {
        use super::normalize;
        assert_eq!(normalize(r"\\?\C:\proj\src\a.lua"), r"C:\proj\src\a.lua");
        // A plain path passes through unchanged (matches the tree's identity).
        assert_eq!(normalize(r"C:\proj\src\a.lua"), r"C:\proj\src\a.lua");
        assert_eq!(normalize("/proj/src/a.lua"), "/proj/src/a.lua");
    }
}
