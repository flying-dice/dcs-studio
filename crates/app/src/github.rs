// GitHub identity commands (model/studio/github.pds, issue #11): thin Tauri
// wrappers over studio-services::github, plus the device-flow poll loop that
// drives the opt-in sign-in. The loop polls the token endpoint on the device
// interval (+5s on `slow_down`), and on success fetches the user, stores the
// session, and emits `github://authorized` (Session); any failure emits
// `github://error`. ureq is blocking, so each call runs on a blocking thread.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

pub use studio_services::github::{DeviceCode, LoginGen, Session};

/// Extra wait added when GitHub answers `slow_down` (model `SLOW_DOWN_BACKOFF_SECONDS`).
const SLOW_DOWN_BACKOFF: Duration = Duration::from_secs(5);

#[derive(Clone, Serialize)]
struct AuthError {
    message: String,
}

fn fail(app: &AppHandle, message: impl Into<String>) {
    let _ = app.emit(
        "github://error",
        AuthError {
            message: message.into(),
        },
    );
}

/// Begin device flow: return the user code + verification URL to display, and
/// spawn the poll loop (model `Identity.Advance`, run on the device interval).
///
/// The loop is fire-and-forget — the webview can't reach in to stop it — so it
/// carries a generation token from [`LoginGen`] and is single-flight: starting
/// again (Sign in -> Cancel -> Sign in) supersedes the prior attempt, and
/// [`github_login_cancel`] supersedes it with none. A superseded/cancelled loop
/// must neither persist a session nor emit a result, so the modal's Cancel honors
/// consent: a code authorized in the browser after Cancel lands on nobody.
#[tauri::command]
pub fn github_login_start(app: AppHandle, login_gen: State<'_, Arc<LoginGen>>) -> Result<DeviceCode, String> {
    start_device_flow(&app, &login_gen, studio_services::github::SIGN_IN_SCOPE)
}

/// Escalate the token to the publishing scope (`public_repo`, issue #12) via the
/// same single-flight device-flow loop as sign-in; on success it stores the
/// broader-scoped token and emits `github://authorized`. The publish UI calls
/// this when the cached token is read-only.
#[tauri::command]
pub fn github_authorize_publish(
    app: AppHandle,
    login_gen: State<'_, Arc<LoginGen>>,
) -> Result<DeviceCode, String> {
    start_device_flow(&app, &login_gen, studio_services::github::PUBLISH_SCOPE)
}

/// The shared device-flow starter: request a code for `scope`, then spawn the
/// generation-guarded poll loop (single-flight + cancellable, issue #11).
fn start_device_flow(
    app: &AppHandle,
    login_gen: &Arc<LoginGen>,
    scope: &str,
) -> Result<DeviceCode, String> {
    let client_id = studio_services::github::client_id();
    let device = studio_services::github::request_device_code(&client_id, scope)?;
    let app = app.clone();

    let device_code = device.device_code.clone();
    let interval = device.interval_seconds.max(1);
    let deadline = Instant::now() + Duration::from_secs(device.expires_in_seconds);

    // Claim this attempt's generation, superseding any loop still running from a
    // prior Sign in. The loop stops as soon as it sees it is no longer current.
    let gen = Arc::clone(login_gen);
    let my_gen = gen.claim();

    tauri::async_runtime::spawn(async move {
        let mut wait = Duration::from_secs(interval);
        loop {
            tokio::time::sleep(wait).await;
            // Superseded by a newer attempt, or cancelled: stop silently — no
            // persist, no emit. (The current attempt owns the github://* events.)
            if !gen.is_current(my_gen) {
                return;
            }
            if Instant::now() >= deadline {
                fail(&app, "the device code expired before authorization");
                return;
            }

            let (cid, dc) = (client_id.clone(), device_code.clone());
            let polled = tauri::async_runtime::spawn_blocking(move || {
                studio_services::github::poll_access_token(&cid, &dc)
            })
            .await;
            // The generation can change while a poll is in flight; re-check
            // before acting on the reply so a Cancel mid-poll is honored.
            if !gen.is_current(my_gen) {
                return;
            }
            let state = match polled {
                Ok(Ok(state)) => state,
                // Transient poll error (network blip / unexpected reply): keep
                // polling rather than abort the flow — the deadline above and the
                // denied/expired arms below bound the loop (#11 "fail soft", so a
                // hiccup never wastes an authorization the user already granted).
                Ok(Err(_)) => continue,
                Err(e) => return fail(&app, format!("poll task failed: {e}")),
            };

            match state.status.as_str() {
                "pending" => {}
                "slow_down" => wait += SLOW_DOWN_BACKOFF,
                "denied" => return fail(&app, "authorization was denied"),
                "expired" => return fail(&app, "the device code expired before authorization"),
                "authorized" => {
                    let token = state.token.clone();
                    // The consent gate. `get_user` is a network round-trip with no
                    // side effect, so the binding check that matters is the one
                    // IMMEDIATELY BEFORE the keyring write: a Cancel arriving while
                    // `get_user` is in flight must not persist. The early check
                    // before `get_user` just skips a needless API call when already
                    // superseded. `None` = superseded/cancelled, so nothing stored.
                    let gen_for_store = Arc::clone(&gen);
                    let stored = tauri::async_runtime::spawn_blocking(move || {
                        if !gen_for_store.is_current(my_gen) {
                            return Ok(None);
                        }
                        let user = studio_services::github::get_user(&token)?;
                        // Re-check after the round-trip, immediately before the
                        // write — this is the gate that actually honors consent.
                        if !gen_for_store.is_current(my_gen) {
                            return Ok(None);
                        }
                        let session = studio_services::github::store_session(&token, &user)?;
                        Ok::<Option<Session>, String>(Some(session))
                    })
                    .await;
                    match stored {
                        Ok(Ok(Some(session))) => {
                            // Only the still-current attempt surfaces its result.
                            if gen.is_current(my_gen) {
                                let _ = app.emit("github://authorized", session);
                            }
                        }
                        // Superseded/cancelled before the store: persist nothing,
                        // emit nothing.
                        Ok(Ok(None)) => {}
                        Ok(Err(message)) => {
                            if gen.is_current(my_gen) {
                                fail(&app, message);
                            }
                        }
                        Err(e) => {
                            if gen.is_current(my_gen) {
                                fail(&app, format!("finalizing sign-in failed: {e}"));
                            }
                        }
                    }
                    return;
                }
                other => return fail(&app, format!("unexpected authorization status: {other}")),
            }
        }
    });

    Ok(device)
}

/// Cancel an in-progress sign-in (model `Identity.CancelSignIn`): supersede the
/// active poll loop so it stops without persisting a session or emitting a
/// result. The sign-in modal calls this on Cancel/X/Esc/backdrop so a code the
/// user later authorizes in the browser does not silently sign them in.
#[tauri::command]
pub fn github_login_cancel(login_gen: State<'_, Arc<LoginGen>>) {
    login_gen.cancel();
}

/// The cached session (profile only), or the dev `DCS_GITHUB_FAKE_LOGIN` bypass.
#[tauri::command]
#[must_use]
pub fn github_session() -> Option<Session> {
    studio_services::github::current_session()
}

/// Sign out: clear the cached token + profile; the chip returns to signed-out.
#[tauri::command]
pub fn github_sign_out() -> Result<(), String> {
    studio_services::github::sign_out()
}
