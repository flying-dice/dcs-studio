// Single-flight cancellation slot for the long-running publish/install commands
// (issue #62 phase 2b). A `*_with_progress` command arms a fresh `Cancel` token
// on start and disarms it once the run settles; the paired `*_cancel` command
// flips whatever token is armed. Each cancellable operation manages its OWN slot
// type (Tauri keys state by type), so publish and install never share a token.
//
// Poison-tolerant like `build::BuildState`: a worker that panicked mid-run must
// never wedge the slot so the next run can't arm.

use std::sync::{Mutex, PoisonError};

use studio_services::progress::Cancel;

/// A held cancellation token for one single-flight operation.
#[derive(Default)]
pub struct CancelSlot(Mutex<Option<Cancel>>);

impl CancelSlot {
    /// Arm a fresh token for a new run, returning a clone the worker observes.
    /// Any previously-armed token is dropped — the prior run has already settled
    /// (single-flight is enforced by the caller's busy guard).
    pub fn arm(&self) -> Cancel {
        let token = Cancel::new();
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(token.clone());
        token
    }

    /// Disarm once a run settles, so a late `*_cancel` flips nothing.
    pub fn disarm(&self) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }

    /// Signal the armed token, if any; a no-op when nothing is running.
    pub fn cancel(&self) {
        if let Some(token) = self.0.lock().unwrap_or_else(PoisonError::into_inner).as_ref() {
            token.cancel();
        }
    }
}
