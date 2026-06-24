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
// then drives the frontend by emitting `deeplink://navigate`. Because a
// cold-start link is dispatched before the webview attaches its listener, the
// navigation is also stashed in `PendingDeepLink`; the frontend drains it once
// on mount via `deeplink_take_pending`.

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

/// A classified deep link — the payload the frontend consumes. `route()`
/// produces this purely; `Ignore` covers every unhandled or malformed input and
/// is never emitted (only logged).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Route {
    /// `marketplace/<owner>/<repo>` → navigate to the product page.
    Marketplace { owner: String, repo: String },
    /// `open?path=<abs>` → open that local project.
    Open { path: String },
    /// Unknown host, unhandled path, or missing argument — ignored, never fatal.
    Ignore,
}

/// The latest navigation captured before the frontend was ready to receive it
/// (cold start). Drained once by `deeplink_take_pending`; `None` in the common
/// already-running case. Managed Tauri state.
#[derive(Default)]
pub struct PendingDeepLink(Mutex<Option<Route>>);

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

/// Drain the cold-start navigation the frontend wasn't yet listening for. The
/// webview calls this once on mount; `None` once drained or when nothing is
/// pending.
#[tauri::command]
pub fn deeplink_take_pending(pending: tauri::State<'_, PendingDeepLink>) -> Option<Route> {
    pending.0.lock().ok().and_then(|mut slot| slot.take())
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
    // early), so the slot never holds Ignore. Stash for the cold-start drain;
    // when the IDE is already running the live emit below delivers the nav and
    // this slot simply goes unread until the next mount.
    if let Some(pending) = app.try_state::<PendingDeepLink>() {
        if let Ok(mut slot) = pending.0.lock() {
            *slot = Some(nav.clone());
        }
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
}
