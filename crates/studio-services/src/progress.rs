//! studio::progress — progress + cancellation primitives for the long-running
//! publish and install operations (issue #62 phase 2). Tauri-free: the app layer
//! threads an `emit` closure as the progress SINK and a [`Cancel`] token (a shared
//! atomic flag) the worker polls. The service crate never names Tauri — exactly as
//! the device-flow `LoginGen` cancel token is injected into `github.rs`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;

/// The error a cancelled operation returns, so the UI can tell a user-cancel apart
/// from a genuine failure (the former rolls back to nothing; the latter may leave a
/// resumable draft).
pub const CANCELLED: &str = "cancelled";

/// A cheap, cloneable cancellation token. The app flips it from a `*_cancel`
/// command; the worker polls [`Cancel::check`] at every step / loop boundary and
/// before each committing side-effect. Single-flight publish/install need only a
/// boolean (no generation counter).
#[derive(Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Signal cancellation. Idempotent.
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    /// `Err(CANCELLED)` once cancelled, so a `?` aborts the pipeline at any check.
    pub fn check(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err(CANCELLED.to_string())
        } else {
            Ok(())
        }
    }
}

/// A no-op progress sink — what the bare (non-`_with_progress`) entry points pass,
/// so existing callers and tests are untouched.
pub fn no_progress<P>() -> impl Fn(P) {
    |_| {}
}

/// The step a publish has reached (issue #62 UI feedback): the ordered pipeline the
/// UI lights up. `Package` covers bundling + 7-Zip packaging; `Split` only fires for
/// a multi-volume payload; `Upload` repeats per asset with `part`/`parts`/`bytes`.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PublishStep {
    Package,
    Split,
    Draft,
    Upload,
    Publish,
}

/// One publish progress event. `detail` names the current asset on an `Upload`;
/// `part`/`parts` are the 1-based asset index and count; `bytes`/`total_bytes` are
/// the cumulative and total upload sizes so the UI can show a byte bar.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct PublishProgress {
    pub step: PublishStep,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parts: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
}

impl PublishProgress {
    /// A bare step event (no quantitative detail) — `package`, `split`, `draft`,
    /// `publish`.
    #[must_use]
    pub fn step(step: PublishStep) -> Self {
        Self { step, detail: None, part: None, parts: None, bytes: None, total_bytes: None }
    }
}

/// The phase an install has reached for a given plan node (issue #62 UI feedback):
/// `Download` (fetch + unpack the node's payload) then `Link` fire once each, per
/// node, so the UI lights a two-step row per mod. Per-volume download byte detail
/// and a split-out `Extract` phase are deferred to 2b, where the download-emit slice
/// adds them.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum InstallPhase {
    Download,
    Link,
}

/// One install progress event. `id` is the `owner/name` being placed; `node`/`nodes`
/// are the 1-based plan-node index and count, so the UI shows "installing k of N".
/// (Per-volume download byte detail is layered on in the download-emit slice.)
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct InstallProgress {
    pub id: String,
    pub phase: InstallPhase,
    pub node: u64,
    pub nodes: u64,
}

impl InstallProgress {
    /// A per-mod phase event for plan node `node` of `nodes`.
    #[must_use]
    pub fn phase(id: &str, phase: InstallPhase, node: u64, nodes: u64) -> Self {
        Self { id: id.to_string(), phase, node, nodes }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_token_flips_and_check_errors_with_the_sentinel() {
        let cancel = Cancel::new();
        assert!(!cancel.is_cancelled());
        assert!(cancel.check().is_ok());
        cancel.cancel();
        assert!(cancel.is_cancelled());
        assert_eq!(cancel.check().unwrap_err(), CANCELLED);
        // A clone shares the flag (the app holds one, the worker another).
        let clone = cancel.clone();
        assert!(clone.is_cancelled());
    }

    #[test]
    fn publish_progress_serializes_kebab_step_and_omits_none_fields() {
        let ev = PublishProgress::step(PublishStep::Draft);
        let json = serde_json::to_string(&ev).unwrap();
        assert_eq!(json, r#"{"step":"draft"}"#, "kebab step, None fields skipped");

        let upload = PublishProgress {
            step: PublishStep::Upload,
            detail: Some("dcs-studio-mod-v1.7z.001".to_string()),
            part: Some(1),
            parts: Some(3),
            bytes: Some(0),
            total_bytes: Some(3000),
        };
        let json = serde_json::to_string(&upload).unwrap();
        assert!(json.contains(r#""step":"upload""#));
        assert!(json.contains(r#""part":1"#) && json.contains(r#""parts":3"#));
        assert!(json.contains(r#""total_bytes":3000"#));
    }

    #[test]
    fn install_progress_serializes_id_kebab_phase_and_node_count() {
        let ev = InstallProgress::phase("octocat/cool-mod", InstallPhase::Download, 2, 3);
        let json = serde_json::to_string(&ev).unwrap();
        assert_eq!(json, r#"{"id":"octocat/cool-mod","phase":"download","node":2,"nodes":3}"#);
    }
}
