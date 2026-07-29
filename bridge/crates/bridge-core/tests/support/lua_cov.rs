//! Lua line coverage for the bridge's own chunks (#66) — the Rust half of the
//! prototype preserved in
//! <https://github.com/flying-dice/dcs-studio/issues/66#issuecomment-5083253665>.
//!
//! [`CoveredLua`] wraps a `Lua` and `Deref`s to it, so a helper that used to
//! return `Lua` returns this instead and every `lua.load(...)` /
//! `bootstrap(&lua, ...)` call downstream reads exactly the same. Construction
//! installs `coverage.lua` — which must happen BEFORE `bootstrap`, so the
//! chunks it loads are measured from their first line — and `Drop` appends
//! `__COV.report()` to `$LUA_COV_DIR/<pid>-<n>.tsv`.
//!
//! Dump-on-drop rather than an explicit call so a test cannot forget, and so a
//! panicking test still contributes what it ran. One file per state because
//! `cargo test` runs a separate process per target and there is no shared
//! memory between them.
//!
//! **With `LUA_COV_DIR` unset the whole thing is inert** — no shim, no hook, no
//! file. That invariant is what keeps instrumentation optional rather than
//! mandatory, and it is asserted by `lua_cov_is_inert_without_the_env_var`.
//!
//! Three env vars, one operational and two that reproduce the experiments
//! board card 05 was opened to run:
//!
//! * `LUA_COV_DIR` — where TSVs are written; unset means inert.
//! * `LUA_COV_MULTIPLEX_LINE_GUESTS` — restores the preserved prototype's
//!   behaviour of multiplexing over a guest that asked for line events.
//!   Reproduces the 3/4 failure in `debug_engine_safety`, which is a stack-depth
//!   defect and not the instrumentation cost it was written up as. See
//!   `coverage.lua`'s `arm`.
//! * `LUA_COV_MULTIPLEX_COUNT` — when set, `arm()` stops handing a
//!   count-hooked thread to the guest and arms one hook for `LUA_MASKLINE |
//!   LUA_MASKCOUNT` instead. This is the experiment in
//!   <https://github.com/flying-dice/dcs-studio/issues/66#issuecomment-5083258905>
//!   §3. Re-run on this branch: the suite stays green and the instruction
//!   budget still cuts off `while true do end`, so the "failed three safety
//!   tests" note on `arm` does not reproduce — but it recovers only 3 further
//!   lines, because the lines it was meant to unlock run INSIDE a hook and Lua
//!   5.1 delivers no events there at all.

use mlua::Lua;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

/// The multiplexing shim, verbatim from the preserved prototype.
const COVERAGE_SHIM: &str = include_str!("coverage.lua");

/// Names the per-state TSV. `cargo test` gives each target its own process, so
/// pid alone is not unique within a run and a counter alone is not unique
/// across targets.
static STATE_SEQ: AtomicUsize = AtomicUsize::new(0);

/// Where TSVs go, or `None` when coverage is off.
fn cov_dir() -> Option<PathBuf> {
    let dir = std::env::var_os("LUA_COV_DIR")?;
    if dir.is_empty() {
        return None;
    }
    Some(PathBuf::from(dir))
}

/// Whether `arm()` should multiplex over count-hooked threads rather than hand
/// them to the guest (issue #66 comment 5083258905 §3).
fn multiplex_count() -> bool {
    std::env::var_os("LUA_COV_MULTIPLEX_COUNT").is_some()
}

/// A Lua state that measures the bridge's Lua chunks, or an ordinary one when
/// `LUA_COV_DIR` is unset.
pub struct CoveredLua {
    lua: Lua,
    /// `Some` only when this state is actually instrumented.
    dump_to: Option<PathBuf>,
}

impl CoveredLua {
    /// Wrap `lua`, installing the coverage shim when `LUA_COV_DIR` is set.
    ///
    /// Call before `bootstrap`.
    pub fn new(lua: Lua) -> Self {
        Self::with_arming(lua, true)
    }

    /// Wrap `lua` and never instrument it, whatever the environment says.
    ///
    /// This is route 4 from #68 §1: arming becomes a per-state decision rather
    /// than a process-wide env var, so a state whose test asserts a sub-second
    /// wall-clock budget opts out on its own while every other state in the
    /// same `cargo test` still measures.
    pub fn unarmed(lua: Lua) -> Self {
        Self::with_arming(lua, false)
    }

    fn with_arming(lua: Lua, arm: bool) -> Self {
        let dump_to = if arm { cov_dir() } else { None };
        if dump_to.is_some() {
            install_shim(&lua);
        }
        Self { lua, dump_to }
    }

    /// True when this state is instrumented — the positive form of the inert
    /// invariant, so a test can assert it rather than infer it from silence.
    pub fn is_instrumented(&self) -> bool {
        self.dump_to.is_some()
    }
}

/// Load `coverage.lua` as `__COV` and start measuring.
///
/// Best effort: a state built without the `debug` library (mlua's safe
/// `Lua::new`) cannot be instrumented at all, and that is not a test failure —
/// `bootstrap` itself has a decline path for exactly that state.
fn install_shim(lua: &Lua) {
    if multiplex_count() {
        let _ = lua.globals().set("__COV_MULTIPLEX_COUNT", true);
    }
    if std::env::var_os("LUA_COV_MULTIPLEX_LINE_GUESTS").is_some() {
        let _ = lua.globals().set("__COV_MULTIPLEX_LINE_GUESTS", true);
    }
    let chunk = lua.load(COVERAGE_SHIM).set_name("=dcs_studio_coverage");
    let Ok(module) = chunk.eval::<mlua::Table>() else {
        return;
    };
    if lua.globals().set("__COV", &module).is_err() {
        return;
    }
    if let Ok(install) = module.get::<mlua::Function>("install") {
        let _ = install.call::<()>(());
    }
}

impl std::ops::Deref for CoveredLua {
    type Target = Lua;

    fn deref(&self) -> &Lua {
        &self.lua
    }
}

impl Drop for CoveredLua {
    fn drop(&mut self) {
        let Some(dir) = self.dump_to.take() else {
            return;
        };
        let Some(report) = read_report(&self.lua) else {
            return;
        };
        if report.is_empty() {
            return;
        }
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let name = format!(
            "{}-{}.tsv",
            std::process::id(),
            STATE_SEQ.fetch_add(1, Ordering::Relaxed)
        );
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(name))
        {
            let _ = writeln!(f, "{report}");
        }
    }
}

/// `__COV.report()`, or `None` if the state was torn down past the point of
/// answering (a Lua panic, a poisoned state). Never propagates: a coverage dump
/// must not be able to turn a passing test into a failing one.
fn read_report(lua: &Lua) -> Option<String> {
    let module = lua.globals().get::<mlua::Table>("__COV").ok()?;
    let report = module.get::<mlua::Function>("report").ok()?;
    report.call::<String>(()).ok()
}
