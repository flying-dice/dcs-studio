//! Shared GitHub HTTP scaffolding: the authenticated request builders plus the
//! API constants, so the marketplace (`market`), publish (`publish`), and
//! identity (`github`) services don't each hand-roll the `User-Agent` + `Bearer`
//! header pair at every call site. Each builder returns a `ureq::Request` the
//! caller finishes — `.set("Accept", …)`, `.query(…)`, `.call()` /
//! `.send_json(…)` / `.send_bytes(…)` — since the `Accept`/body shape varies per
//! endpoint while the auth headers do not. ureq is blocking; callers run it off
//! the UI thread.

/// GitHub REST API base (`https://api.github.com`).
pub(crate) const API_BASE: &str = "https://api.github.com";

/// The `User-Agent` GitHub requires on every request: `dcs-studio/<version>`.
pub(crate) const USER_AGENT: &str = concat!("dcs-studio/", env!("CARGO_PKG_VERSION"));

/// GitHub's vendor JSON media type — the usual `Accept` for REST calls.
pub(crate) const ACCEPT_JSON: &str = "application/vnd.github+json";

/// An authenticated `GET`, with `User-Agent` + `Bearer {token}` set.
pub(crate) fn get(url: &str, token: &str) -> ureq::Request {
    authed(ureq::get(url), token)
}

/// An authenticated `POST`, with `User-Agent` + `Bearer {token}` set.
pub(crate) fn post(url: &str, token: &str) -> ureq::Request {
    authed(ureq::post(url), token)
}

/// An authenticated `PUT`, with `User-Agent` + `Bearer {token}` set.
pub(crate) fn put(url: &str, token: &str) -> ureq::Request {
    authed(ureq::put(url), token)
}

fn authed(req: ureq::Request, token: &str) -> ureq::Request {
    req.set("User-Agent", USER_AGENT)
        .set("Authorization", &format!("Bearer {token}"))
}
