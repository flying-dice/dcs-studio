// GitHub identity via OAuth device flow (model/studio/github.pds, issue #11).
// Tauri-free primitives: the HTTP calls (ureq, like signing.rs) + the keyring
// token store live here; the app crate (crates/app/src/github.rs) drives the
// timing/poll loop and emits UI events. The access token NEVER leaves the Rust
// side — it lives only in the keyring; callers get `Session` (profile only).

use serde::{Deserialize, Serialize};

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const USER_URL: &str = "https://api.github.com/user";
const USER_AGENT: &str = concat!("dcs-studio/", env!("CARGO_PKG_VERSION"));

/// OAuth scope (model `DEVICE_SCOPE`): `read:user` only — least privilege for the
/// identity slice (the consent screen reads "read your profile"). Repo
/// provisioning (#12) escalates to `repo`/`workflow` when it needs them.
const SCOPE: &str = "read:user";

/// Placeholder OAuth App client_id — the real one comes from `DCS_GITHUB_CLIENT_ID`
/// (a public value; device flow needs no client secret). With the placeholder,
/// `request_device_code` fails fast; the `DCS_GITHUB_FAKE_LOGIN` bypass covers dev.
const PLACEHOLDER_CLIENT_ID: &str = "Ov23li-dcsstudio-placeholder";

/// A device-flow handshake (model `DeviceCode`). Only `user_code` +
/// `verification_uri` serialize to the webview; `device_code` (the poll
/// credential) and the timings are `serde(skip)` — read Rust-side by the poll
/// loop, never handed to JS.
#[derive(Clone, Debug, Serialize)]
pub struct DeviceCode {
    pub user_code: String,
    pub verification_uri: String,
    #[serde(skip)]
    pub device_code: String,
    #[serde(skip)]
    pub interval_seconds: u64,
    #[serde(skip)]
    pub expires_in_seconds: u64,
}

/// A classified poll response (model `PollState`); `token` set only when
/// `status == "authorized"`.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct PollState {
    pub status: String,
    pub token: String,
}

/// A GitHub user profile from the API.
#[derive(Clone, Debug, Serialize)]
pub struct GitHubUser {
    pub login: String,
    pub avatar_url: String,
}

/// The cached, UI-facing session (model `Session`) — profile only, never the token.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Session {
    pub login: String,
    pub avatar_url: String,
}

/// What the keyring holds: token + profile. Only the profile is ever handed out.
#[derive(Clone, Serialize, Deserialize)]
struct StoredSession {
    token: String,
    login: String,
    avatar_url: String,
}

/// The public OAuth App client_id: `DCS_GITHUB_CLIENT_ID`, else the placeholder.
#[must_use]
pub fn client_id() -> String {
    resolve_client_id(std::env::var("DCS_GITHUB_CLIENT_ID").ok())
}

/// Pure resolver (testable without touching the process env).
fn resolve_client_id(env: Option<String>) -> String {
    env.filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| PLACEHOLDER_CLIENT_ID.to_string())
}

/// Dev/e2e sign-in bypass: in DEBUG builds, `DCS_GITHUB_FAKE_LOGIN=<login>` reports
/// that login as signed-in without any GitHub call. Compiled OUT of release
/// builds, so a shipped artifact can't be trivially signed in or made to sign
/// packages under a forged identity.
#[cfg(debug_assertions)]
fn fake_login() -> Option<String> {
    std::env::var("DCS_GITHUB_FAKE_LOGIN")
        .ok()
        .filter(|v| !v.trim().is_empty())
}

#[cfg(not(debug_assertions))]
fn fake_login() -> Option<String> {
    None
}

/// Begin device flow: returns the user code + verification URL to display.
pub fn request_device_code(client_id: &str) -> Result<DeviceCode, String> {
    #[derive(Deserialize)]
    struct Resp {
        device_code: String,
        user_code: String,
        verification_uri: String,
        expires_in: u64,
        interval: u64,
    }
    let body = serde_json::json!({ "client_id": client_id, "scope": SCOPE });
    let resp: Resp = ureq::post(DEVICE_CODE_URL)
        .set("Accept", "application/json")
        .set("User-Agent", USER_AGENT)
        .send_json(body)
        .map_err(|e| format!("device-code request failed: {e}"))?
        .into_json()
        .map_err(|e| format!("device-code response: {e}"))?;
    Ok(DeviceCode {
        user_code: resp.user_code,
        verification_uri: resp.verification_uri,
        device_code: resp.device_code,
        interval_seconds: resp.interval,
        expires_in_seconds: resp.expires_in,
    })
}

/// One poll of the token endpoint, classified (model `GitHub.PollAccessToken`).
/// `pending`/`slow_down`/`authorized`/`denied`/`expired` are `Ok`; an unknown or
/// empty response is `Err` so it surfaces rather than looping forever.
pub fn poll_access_token(client_id: &str, device_code: &str) -> Result<PollState, String> {
    let body = serde_json::json!({
        "client_id": client_id,
        "device_code": device_code,
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
    });
    let (access_token, error) = read_token_response(
        ureq::post(TOKEN_URL)
            .set("Accept", "application/json")
            .set("User-Agent", USER_AGENT)
            .send_json(body),
    )?;
    classify(access_token.as_deref(), error.as_deref())
}

/// Read `(access_token, error)` from a token-endpoint response, tolerating the
/// non-2xx GitHub sometimes returns for flow errors.
fn read_token_response(
    result: Result<ureq::Response, ureq::Error>,
) -> Result<(Option<String>, Option<String>), String> {
    let resp = match result {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => return Err(format!("token poll failed: {e}")),
    };
    #[derive(Deserialize)]
    struct Resp {
        access_token: Option<String>,
        error: Option<String>,
    }
    let parsed: Resp = resp
        .into_json()
        .map_err(|e| format!("token response: {e}"))?;
    Ok((parsed.access_token, parsed.error))
}

/// Pure classifier of a token-endpoint reply into a `PollState`.
fn classify(access_token: Option<&str>, error: Option<&str>) -> Result<PollState, String> {
    if let Some(token) = access_token.filter(|t| !t.is_empty()) {
        return Ok(PollState {
            status: "authorized".to_string(),
            token: token.to_string(),
        });
    }
    let status = match error {
        Some("authorization_pending") => "pending",
        Some("slow_down") => "slow_down",
        Some("access_denied") => "denied",
        Some("expired_token") => "expired",
        Some(other) => return Err(format!("GitHub authorization error: {other}")),
        None => return Err("GitHub token endpoint returned neither a token nor an error".to_string()),
    };
    Ok(PollState {
        status: status.to_string(),
        token: String::new(),
    })
}

/// The authenticated user's profile (model `GitHub.GetUser`).
pub fn get_user(token: &str) -> Result<GitHubUser, String> {
    #[derive(Deserialize)]
    struct Resp {
        login: String,
        avatar_url: String,
    }
    let resp: Resp = ureq::get(USER_URL)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", USER_AGENT)
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| format!("get-user failed: {e}"))?
        .into_json()
        .map_err(|e| format!("user response: {e}"))?;
    Ok(GitHubUser {
        login: resp.login,
        avatar_url: resp.avatar_url,
    })
}

/// Persist the token + profile; return the UI-facing session (model `StoreSession`).
pub fn store_session(token: &str, user: &GitHubUser) -> Result<Session, String> {
    store::save(&StoredSession {
        token: token.to_string(),
        login: user.login.clone(),
        avatar_url: user.avatar_url.clone(),
    })?;
    Ok(Session {
        login: user.login.clone(),
        avatar_url: user.avatar_url.clone(),
    })
}

/// The cached session (profile only), or the dev/e2e fake login (model
/// `Identity.CachedSession`).
#[must_use]
pub fn current_session() -> Option<Session> {
    if let Some(login) = fake_login() {
        return Some(Session {
            login,
            avatar_url: String::new(),
        });
    }
    store::load().map(|s| Session {
        login: s.login,
        avatar_url: s.avatar_url,
    })
}

/// Clear the cached token + profile; the chip returns to signed-out (model `Identity.SignOut`).
pub fn sign_out() -> Result<(), String> {
    store::clear()
}

/// Single-flight + cancel guard for the device-flow poll loop (model
/// `Identity.CancelSignIn`). The poll loop is fire-and-forget — the webview
/// can't reach in to stop it — so it carries a generation token and checks here
/// before it persists a session or emits a result. [`claim`](Self::claim)
/// starts a new attempt and supersedes any prior one; [`cancel`](Self::cancel)
/// supersedes the active attempt with none. A loop whose generation is no longer
/// current (a newer attempt started, or the user cancelled) must neither persist
/// nor emit — that is what lets the sign-in modal's Cancel/reopen honor consent.
#[derive(Debug, Default)]
pub struct LoginGen(std::sync::atomic::AtomicU64);

impl LoginGen {
    /// Claim the next generation for a fresh attempt, superseding any prior one;
    /// returns the claimed generation for the loop to check against.
    pub fn claim(&self) -> u64 {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
    }

    /// Whether `generation` is still the active attempt (not superseded/cancelled).
    #[must_use]
    pub fn is_current(&self, generation: u64) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst) == generation
    }

    /// Cancel the active attempt: bump the generation so no live loop is current
    /// any more (none persists or emits) until the next `claim`.
    pub fn cancel(&self) {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}

// --- token store: Windows Credential Manager (real), in-memory elsewhere ------

#[cfg(windows)]
mod store {
    use super::StoredSession;

    const SERVICE: &str = "dcs-studio";
    const ACCOUNT: &str = "github";

    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("keyring: {e}"))
    }

    pub fn save(stored: &StoredSession) -> Result<(), String> {
        let json = serde_json::to_string(stored).map_err(|e| e.to_string())?;
        entry()?
            .set_password(&json)
            .map_err(|e| format!("keyring store: {e}"))
    }

    pub fn load() -> Option<StoredSession> {
        let json = entry().ok()?.get_password().ok()?;
        serde_json::from_str(&json).ok()
    }

    pub fn clear() -> Result<(), String> {
        match entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("keyring delete: {e}")),
        }
    }
}

// Non-Windows (CI/dev): an in-memory store so the crate compiles and tests run
// without an OS credential service. The app targets Windows, where the real
// keyring above is used.
#[cfg(not(windows))]
mod store {
    use super::StoredSession;
    use std::sync::Mutex;

    static MEM: Mutex<Option<StoredSession>> = Mutex::new(None);

    fn lock() -> std::sync::MutexGuard<'static, Option<StoredSession>> {
        MEM.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn save(stored: &StoredSession) -> Result<(), String> {
        *lock() = Some(stored.clone());
        Ok(())
    }

    pub fn load() -> Option<StoredSession> {
        lock().clone()
    }

    pub fn clear() -> Result<(), String> {
        *lock() = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{classify, resolve_client_id, PLACEHOLDER_CLIENT_ID};

    #[test]
    fn classify_maps_every_device_flow_arm() {
        assert_eq!(
            classify(Some("gho_abc"), None).expect("authorized").status,
            "authorized"
        );
        assert_eq!(
            classify(Some("gho_abc"), None).expect("authorized").token,
            "gho_abc"
        );
        assert_eq!(
            classify(None, Some("authorization_pending")).expect("pending").status,
            "pending"
        );
        assert_eq!(
            classify(None, Some("slow_down")).expect("slow_down").status,
            "slow_down"
        );
        assert_eq!(
            classify(None, Some("access_denied")).expect("denied").status,
            "denied"
        );
        assert_eq!(
            classify(None, Some("expired_token")).expect("expired").status,
            "expired"
        );
    }

    #[test]
    fn classify_surfaces_unknown_and_empty_replies_as_errors() {
        assert!(classify(None, Some("incorrect_client_credentials")).is_err());
        assert!(classify(None, None).is_err());
        // An empty access_token is not "authorized".
        assert!(classify(Some(""), Some("authorization_pending")).expect("pending").status == "pending");
    }

    #[test]
    fn resolve_client_id_prefers_env_then_placeholder() {
        assert_eq!(resolve_client_id(Some("Iv1.real".to_string())), "Iv1.real");
        assert_eq!(resolve_client_id(Some("  ".to_string())), PLACEHOLDER_CLIENT_ID);
        assert_eq!(resolve_client_id(None), PLACEHOLDER_CLIENT_ID);
    }

    // Runs where the store is the in-memory fallback (CI/Linux); on Windows it is
    // cfg'd out so `cargo test` never touches the real Credential Manager.
    #[test]
    fn login_gen_supersedes_and_cancels_so_stale_loops_stop() {
        use super::LoginGen;
        let g = LoginGen::default();

        // A fresh attempt is the current one.
        let a = g.claim();
        assert!(g.is_current(a));

        // A second attempt (Sign in -> Sign in) supersedes the first: the
        // abandoned loop A is no longer current, so it must not persist/emit.
        let b = g.claim();
        assert!(!g.is_current(a), "the superseded attempt stops");
        assert!(g.is_current(b));

        // Cancel (modal Cancel/X/Esc) supersedes the active attempt with none —
        // no live loop is current, so a later authorize lands on nobody.
        g.cancel();
        assert!(!g.is_current(b), "the cancelled attempt stops");

        // The next Sign in claims a fresh, current generation again.
        let c = g.claim();
        assert!(g.is_current(c));
        assert!(!g.is_current(a));
        assert!(!g.is_current(b));
    }

    #[cfg(not(windows))]
    #[test]
    fn session_round_trip_stores_profile_only_and_clears() {
        use super::{current_session, sign_out, store_session, GitHubUser};
        let user = GitHubUser {
            login: "octocat".to_string(),
            avatar_url: "https://example.invalid/a.png".to_string(),
        };
        let session = store_session("gho_secret_token", &user).expect("store");
        // The returned + cached session is profile only — Session has no token.
        assert_eq!(session.login, "octocat");
        let cached = current_session().expect("a session is cached");
        assert_eq!(cached.login, "octocat");
        assert_eq!(cached.avatar_url, "https://example.invalid/a.png");
        sign_out().expect("sign out");
        assert!(current_session().is_none(), "sign-out clears the session");
    }
}
