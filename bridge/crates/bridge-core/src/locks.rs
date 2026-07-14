//! One poison-recovering `Mutex` accessor, shared by the DLL's process-wide
//! state modules (`debug`, `console`). Extracted so the recovery rationale is
//! stated once rather than copied into every `with_*`/`*_slot` wrapper.

use std::sync::{Mutex, PoisonError};

/// Run `f` against the guarded value of `m`, recovering the guard if the lock
/// was poisoned. A prior panic while holding the lock poisons it, but the data
/// behind these locks (line-number sets, a ring buffer, a pause snapshot) can't
/// be left half-updated in a way that matters — so we take the inner value and
/// carry on rather than `unwrap`-panic in a DLL that must never bring the sim
/// down.
pub(crate) fn with_lock<T, R>(m: &'static Mutex<T>, f: impl FnOnce(&mut T) -> R) -> R {
    let mut guard = m.lock().unwrap_or_else(PoisonError::into_inner);
    f(&mut guard)
}
