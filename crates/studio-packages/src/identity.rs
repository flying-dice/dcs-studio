//! The signing identity (model `studio::package::Identity` / `IdentityProvider`).
//!
//! The IDP is a polymorphic seam: [`StaticIdentity`] is a single fixed user for
//! now; the GitHub device-flow login (issue #11) implements [`IdentityProvider`]
//! and drops in without touching the packaging code.

use serde::{Deserialize, Serialize};

/// The logged-in author requesting a signature — its `login` is the revocation
/// key the server tracks.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Identity {
    pub login: String,
}

/// A source of the current logged-in identity.
pub trait IdentityProvider {
    /// The current author, or `None` when logged out.
    fn current(&self) -> Option<Identity>;
}

/// A single fixed user (or logged-out) — the polymorphic IDP's stand-in until
/// the GitHub device-flow login (issue #11) implements [`IdentityProvider`].
pub struct StaticIdentity {
    login: Option<String>,
}

impl StaticIdentity {
    /// A provider that reports `login` as the current user.
    pub fn new(login: impl Into<String>) -> Self {
        Self {
            login: Some(login.into()),
        }
    }

    /// A provider that reports nobody logged in.
    #[must_use]
    pub fn logged_out() -> Self {
        Self { login: None }
    }
}

impl IdentityProvider for StaticIdentity {
    fn current(&self) -> Option<Identity> {
        self.login.clone().map(|login| Identity { login })
    }
}
