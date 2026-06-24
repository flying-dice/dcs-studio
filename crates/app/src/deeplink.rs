// Deep-link router (model/studio/deeplink.pds, issue #44): registers the
// `dcs-studio://` scheme and dispatches an incoming URL by HOST (the area) then
// PATH/QUERY (the arguments). Two routes ship: `marketplace/<owner>/<repo>`
// navigates the IDE to the mod's product page, and `open?path=<abs>` opens a
// local project. Unknown host / unhandled path / missing argument is ignored,
// never fatal — a stray link must not crash the IDE.
//
// On Windows/Linux a deep link launches a new process with the URL in argv:
// tauri-plugin-single-instance forwards a second instance's argv here
// (`handle_argv`), while `on_open_url` plus the launch argv cover the cold-start
// path (and macOS).
//
// `route()` is a pure classifier (URL → `Route`), unit-tested as a dispatch
// table. `dispatch()` performs the effect — it validates the `open` target,
// then drives the frontend by emitting `deeplink://navigate`. A cold-start link
// is dispatched before the webview attaches its listener, so until the frontend
// drains once on mount (via `deeplink_take_pending`) that navigation is stashed
// in `PendingDeepLink`; links routed after the frontend is live are emit-only.

use std::path::Path;
use std::sync::Mutex;

use dcs_studio_project::MANIFEST_FILE;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

pub const SCHEME: &str = "dcs-studio";

/// The single frontend navigation event both routes drive.
const NAVIGATE_EVENT: &str = "deeplink://navigate";

/// A classified deep link — the payload the frontend consumes (the serialized
/// return of `deeplink_take_pending`, so `pub` like the crate's other command
/// types). `route()` produces this purely; `Ignore` covers every unhandled or
/// malformed input and is never emitted (only logged).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Route {
    /// `marketplace/<owner>/<repo>` → navigate to the product page.
    Marketplace { owner: String, repo: String },
    /// `open?path=<abs>` → open that local project.
    Open { path: String },
    /// Unknown host, unhandled path, or missing argument — ignored, never fatal.
    Ignore,
}

/// Bridges a cold-start navigation — one routed before the frontend attached its
/// live listener — to the webview, which drains it once on mount via
/// `deeplink_take_pending`. The slot is a cold-start bridge ONLY: it lives in the
/// Rust process, which outlives a webview reload, so once the frontend has armed
/// (drained once) every dispatch is delivered live by the emit and nothing is
/// retained — else a reload would re-drain and re-fire a long-stale nav. Managed
/// Tauri state.
#[derive(Default)]
pub struct PendingDeepLink(Mutex<PendingState>);

/// The cold-start slot plus the one-way latch that closes it. Both sit behind a
/// single lock so a dispatch's stash and the frontend's drain can't interleave
/// into a lost update (a stash landing just after the drain, never delivered).
#[derive(Default)]
struct PendingState {
    /// The latest cold-start navigation awaiting the frontend's first drain.
    slot: Option<Route>,
    /// Latched by the first drain: the frontend's listener is live from then on,
    /// so further dispatches are emit-only and must not be stashed.
    frontend_ready: bool,
}

impl PendingDeepLink {
    /// Capture a navigation for the cold-start drain — but only until the
    /// frontend has armed. Once it has, the live emit in `dispatch` delivers
    /// every nav and retaining one would re-fire it stale on a webview reload.
    fn stash_if_cold(&self, nav: &Route) {
        let Ok(mut state) = self.0.lock() else {
            return;
        };
        if !state.frontend_ready {
            state.slot = Some(nav.clone());
        }
    }

    /// Drain the cold-start nav and latch the frontend ready, closing the stash.
    /// `None` once drained or when nothing was pending.
    fn take(&self) -> Option<Route> {
        let Ok(mut state) = self.0.lock() else {
            return None;
        };
        state.frontend_ready = true;
        state.slot.take()
    }
}

/// Register the scheme with the OS (dev; prod registers via the installer),
/// start listening for opened URLs, and route the URL this process was cold-
/// started with (Windows delivers it in argv, not via `on_open_url`). Called
/// once from `setup`.
pub fn setup(app: &AppHandle) {
    if let Err(e) = app.deep_link().register_all() {
        tracing::warn!(error = %e, "deep-link scheme registration failed (continuing)");
    }
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            dispatch(&handle, &url);
        }
    });
    // Cold start: Windows/Linux deliver the launching URL in this process's
    // argv (macOS uses `on_open_url` above and does not put it in argv), so this
    // scan only finds anything on the argv platforms. If a platform ever fires
    // both, the re-dispatch is harmless — every effect here is idempotent: the
    // pending slot is overwritten with the same nav, `openPath` guards re-entry,
    // and navigating to the same route is a no-op.
    let argv: Vec<String> = std::env::args().collect();
    handle_argv(app, &argv);
}

/// Route every `dcs-studio://` URL among process arguments — the single-instance
/// callback hands the second instance's argv here so the running IDE handles it.
pub fn handle_argv(app: &AppHandle, argv: &[String]) {
    for url in deep_link_urls(argv) {
        dispatch(app, &url);
    }
}

/// Drain the cold-start navigation the frontend wasn't yet listening for, and
/// latch the frontend ready so later dispatches deliver live only. The webview
/// calls this once on mount; `None` once drained or when nothing is pending.
#[tauri::command]
pub fn deeplink_take_pending(pending: tauri::State<'_, PendingDeepLink>) -> Option<Route> {
    pending.take()
}

/// The `dcs-studio://` URLs among process arguments. A non-URL entry (the
/// program name, a flag) or another scheme is skipped — a stray argv entry must
/// never error. Pure; unit-tested.
fn deep_link_urls(argv: &[String]) -> Vec<Url> {
    argv.iter()
        .filter_map(|arg| Url::parse(arg).ok())
        .filter(|url| url.scheme() == SCHEME)
        .collect()
}

/// Perform the routed effect: validate the `open` target, stash the navigation
/// (for a cold-start drain), and emit `deeplink://navigate` to the frontend. An
/// ignored or invalid route is logged, never emitted — total, never fatal. (The
/// model's `NavigateToProduct` / `OpenProject` / `Ignore` handlers are the
/// `Route` variants; this is their one effectful site.)
fn dispatch(app: &AppHandle, url: &Url) {
    let nav = route(url);
    match &nav {
        Route::Ignore => {
            tracing::debug!(url = %url, "deep link: no route, ignoring");
            return;
        }
        // The security gate: a web link may only open an existing, recognized
        // project root, and even then only READS it.
        Route::Open { path } if !is_project_root(path) => {
            tracing::debug!(path = %path, "deep link open: not a recognized project root, ignoring");
            return;
        }
        _ => {}
    }
    // Only Marketplace/Open reach here (Ignore and an invalid Open returned
    // early), so a stashed nav is never Ignore. Stash *only* until the frontend
    // has armed: a cold-start link routed before the webview's listener existed
    // is carried by the drain, but once the frontend is live the emit below
    // delivers every nav and retaining one would re-fire it stale on a reload.
    if let Some(pending) = app.try_state::<PendingDeepLink>() {
        pending.stash_if_cold(&nav);
    }
    if let Err(e) = app.emit(NAVIGATE_EVENT, &nav) {
        tracing::warn!(error = %e, "deep link: navigate emit failed");
    }
}

/// Classify a `dcs-studio://` URL into a route. Pure and total — every unhandled
/// host, path shape, or missing argument yields `Ignore` (model
/// `studio::deeplink::DeepLink::Route`).
fn route(url: &Url) -> Route {
    match url.host_str() {
        Some("marketplace") => match path_segments(url).as_slice() {
            [owner, repo] => Route::Marketplace {
                owner: (*owner).to_string(),
                repo: (*repo).to_string(),
            },
            _ => Route::Ignore,
        },
        Some("open") => match query_path(url) {
            Some(path) => Route::Open { path },
            None => Route::Ignore,
        },
        _ => Route::Ignore,
    }
}

/// Non-empty path segments of `url` (drops the empties from a leading, trailing,
/// or doubled `/`).
fn path_segments(url: &Url) -> Vec<&str> {
    match url.path_segments() {
        Some(segments) => segments.filter(|s| !s.is_empty()).collect(),
        None => Vec::new(),
    }
}

/// The url-decoded, non-empty `path` query parameter of `url`, if present.
fn query_path(url: &Url) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key.as_ref() == "path")
        .map(|(_, value)| value.into_owned())
        .filter(|path| !path.is_empty())
}

/// Whether `path` is an existing, recognized project root: a directory holding a
/// `dcs-studio.toml` manifest. Guards the `open` route.
fn is_project_root(path: &str) -> bool {
    let root = Path::new(path);
    root.is_dir() && root.join(MANIFEST_FILE).is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect("test url parses")
    }

    #[test]
    fn marketplace_route_takes_owner_and_repo() {
        assert_eq!(
            route(&url("dcs-studio://marketplace/acme/super-mod")),
            Route::Marketplace {
                owner: "acme".to_string(),
                repo: "super-mod".to_string(),
            }
        );
    }

    #[test]
    fn marketplace_route_ignores_missing_repo() {
        assert_eq!(route(&url("dcs-studio://marketplace/acme")), Route::Ignore);
    }

    #[test]
    fn marketplace_route_ignores_extra_segments() {
        assert_eq!(
            route(&url("dcs-studio://marketplace/acme/super-mod/extra")),
            Route::Ignore
        );
    }

    #[test]
    fn open_route_decodes_the_path_query() {
        assert_eq!(
            route(&url("dcs-studio://open?path=%2Fhome%2Fme%2Fproj")),
            Route::Open {
                path: "/home/me/proj".to_string(),
            }
        );
    }

    #[test]
    fn open_route_ignores_missing_path_param() {
        assert_eq!(route(&url("dcs-studio://open")), Route::Ignore);
    }

    #[test]
    fn open_route_ignores_empty_path_param() {
        assert_eq!(route(&url("dcs-studio://open?path=")), Route::Ignore);
    }

    #[test]
    fn unknown_host_is_ignored() {
        assert_eq!(route(&url("dcs-studio://nonsense/whatever")), Route::Ignore);
    }

    #[test]
    fn deep_link_urls_skips_non_scheme_and_unparseable_argv() {
        let argv = vec![
            "dcs-studio.exe".to_string(),                       // program name, not a URL
            "--open".to_string(),                               // a flag, not a URL
            "https://example.com/x".to_string(),               // another scheme
            "dcs-studio://open?path=%2Ftmp%2Fp".to_string(),   // the real one
        ];
        let urls = deep_link_urls(&argv);
        assert_eq!(urls.len(), 1);
        assert_eq!(
            route(&urls[0]),
            Route::Open {
                path: "/tmp/p".to_string(),
            }
        );
    }

    #[test]
    fn is_project_root_requires_a_manifest_in_a_dir() {
        let dir = std::env::temp_dir().join(format!("dcs-deeplink-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp project dir");
        let path = dir.to_string_lossy().into_owned();

        // A bare directory is not a project root…
        assert!(!is_project_root(&path));
        // …until it carries a dcs-studio.toml.
        std::fs::write(dir.join(MANIFEST_FILE), "[project]\nname = \"t\"\n").expect("write manifest");
        assert!(is_project_root(&path));

        // A path that does not exist is not a root.
        let missing = dir.join("nope").to_string_lossy().into_owned();
        assert!(!is_project_root(&missing));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pending_bridges_cold_start_then_closes_after_drain() {
        // A link that cold-started the IDE is routed before the frontend's
        // listener exists: stash it so the first drain delivers it.
        let pending = PendingDeepLink::default();
        let cold = Route::Open {
            path: "/proj".to_string(),
        };
        pending.stash_if_cold(&cold);
        assert_eq!(pending.take(), Some(cold));

        // The frontend is armed now (it drained once). A later dispatch is
        // delivered live by the emit, so it must NOT be retained — else a webview
        // reload would re-drain and re-fire this stale nav (the bug this guards).
        let live = Route::Marketplace {
            owner: "acme".to_string(),
            repo: "mod".to_string(),
        };
        pending.stash_if_cold(&live);
        assert_eq!(pending.take(), None);
    }

    #[test]
    fn pending_already_running_never_stashes() {
        // Already-running start: the frontend mounts and drains before any link,
        // so the first drain finds nothing and latches the slot closed.
        let pending = PendingDeepLink::default();
        assert_eq!(pending.take(), None);

        // Every dispatch from here is live; nothing is stashed for a reload to
        // re-fire.
        pending.stash_if_cold(&Route::Open {
            path: "/proj".to_string(),
        });
        assert_eq!(pending.take(), None);
    }
}
