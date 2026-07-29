//! Letting go of a Lua state before DCS destroys it.
//!
//! The mission DLL is `require`d into a FRESH mission Lua state on every
//! mission load, and until now nothing ran on the way out: DCS called
//! `lua_close` on that state while the bridge still held handles into it. The
//! handles are the router's — a `HashMap<String, LuaFunction>` (see
//! [`crate::jsonrpc::router`]) reachable from the mission state's model-time
//! pump closure and from `DBG.pump`. Nothing drops them until the router
//! userdata's `__gc` runs, and Lua 5.1 runs `__gc` *during* `lua_close`: every
//! one of those drops then hands a registry reference back to a state that is
//! already tearing down, in an order Lua does not define relative to mlua's own
//! registry bookkeeping. That is the only place the mission bridge reaches into
//! a dying state, and card 18 / issue #69 has it as the remaining suspect for a
//! DCS that dies silently ~9 s after `Dispatcher: Stop`.
//!
//! So: release first, and leave `__gc` nothing to do. Two triggers, because
//! neither alone is enough.
//!
//! * **While the state is alive** — [`release`], driven from the mission state
//!   by its `S_EVENT_MISSION_END` handler (see `lua/mission_init.lua`). This is
//!   the one that actually fixes the hazard: it drops the router's handles at a
//!   point where the state is fully functional, so the `__gc` that follows
//!   collects an empty map.
//! * **While the state is closing** — [`StateGuard`], a sentinel userdata
//!   parked in the mission state whose destructor mlua runs from `__gc`. It
//!   CANNOT drop the router's Lua handles (calling into Lua from there is the
//!   very thing being avoided), so it does the half that needs no Lua: it fails
//!   every request stranded in the queue. It is the backstop for a mission that
//!   ends without ever firing `S_EVENT_MISSION_END`.
//!
//! Everything here is idempotent and re-armable: the next mission's `require`
//! calls `jsonrpc.serve`, which [`rearm`]s this module, so a second state boots
//! against the same statics as if the first had never existed.

use crate::jsonrpc::router::JsonRpcRouter;
use crate::jsonrpc::server;
use log::info;
use mlua::UserData;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};

/// Whether the Lua state this DLL serves has already been released. Per DLL,
/// like every other static in this crate. Read to keep the two triggers
/// idempotent, and cleared by [`rearm`] when the next mission boots.
static RELEASED: AtomicBool = AtomicBool::new(false);

/// What the bridge tells a stranded caller when its mission ended under it.
const MISSION_STATE_GONE: &str =
    "the mission Lua state was torn down before this request could be answered";

/// Whether [`release`] (or a [`StateGuard`] destructor) has already run for the
/// state this DLL currently serves.
///
/// Only the tests read it: in production the flag exists to keep the two
/// triggers from reporting the same teardown twice, and nothing needs to ask.
#[cfg(test)]
fn released() -> bool {
    RELEASED.load(Ordering::SeqCst)
}

/// Arm this module for a fresh Lua state. Called from `jsonrpc.serve` on every
/// mission load — including the reuse path, which is the only one a second
/// mission takes — so a state released by the previous mission does not leave
/// this DLL believing the new one is already gone.
pub(crate) fn rearm() {
    if RELEASED.swap(false, Ordering::SeqCst) {
        info!("teardown: re-armed for a fresh Lua state");
    }
}

/// Release everything this DLL holds in `router`'s Lua state, while that state
/// is still alive: drop every registered handler, then fail every request
/// stranded in the running server's queue. Returns
/// `(handlers_released, requests_failed)`.
///
/// Idempotent — a mission that fires its end event and *then* gets collected
/// runs this twice, and the second run has nothing left to do.
pub(crate) fn release(router: &mut JsonRpcRouter, reason: &str) -> (usize, usize) {
    let handlers = router.release();
    let failed = server::fail_queued(reason);
    let first = !RELEASED.swap(true, Ordering::SeqCst);
    if first || handlers > 0 || failed > 0 {
        info!(
            "teardown ({reason}): released {handlers} Lua handler(s), \
             failed {failed} queued request(s)"
        );
    }
    (handlers, failed)
}

/// A sentinel parked in the Lua state whose destruction it reports: mlua runs a
/// userdata destructor from `__gc`, and Lua 5.1 runs `__gc` for every live
/// userdata during `lua_close`. So dropping this is the one signal a DLL gets
/// when DCS destroys a state it was never told about.
///
/// Deliberately holds nothing. It runs on the far side of a `lua_close` that is
/// already in progress, where the only safe work is work that never touches
/// Lua.
pub(crate) struct StateGuard;

impl UserData for StateGuard {}

impl Drop for StateGuard {
    fn drop(&mut self) {
        // No Lua, by construction — see the type's docs. What is left is the
        // queue, which is plain Rust data behind a recovered lock.
        //
        // Under `catch_unwind` because this frame is reached from a C `__gc`
        // callback inside `lua_close`: mlua catches panics out of its own
        // callbacks, but a panic escaping a destructor during that unwind would
        // abort, and inside DCS an abort is the sim closing itself — the exact
        // failure class this module exists to remove. The discarded `Err` is
        // the point: there is nowhere left to report to.
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let failed = server::fail_queued(MISSION_STATE_GONE);
            let first = !RELEASED.swap(true, Ordering::SeqCst);
            if first {
                info!(
                    "teardown (lua_close): the Lua state was collected without an \
                     explicit release — failed {failed} queued request(s). The \
                     router's handlers were dropped by __gc, not before it."
                );
            }
        }));
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod tests {
    use super::{rearm, release, released, StateGuard, MISSION_STATE_GONE};
    use crate::jsonrpc::router::{JsonRpcRouter, MethodMeta};
    use crate::jsonrpc::server::{queue_against_running_server, retire_server};
    use crate::jsonrpc::{serially, JsonRpcRequest, JSON_RPC_BRIDGE_TORN_DOWN, JSON_RPC_VERSION};
    use mlua::Lua;

    /// A request as a transport would have queued it.
    fn request(id: &str) -> JsonRpcRequest {
        JsonRpcRequest {
            jsonrpc: JSON_RPC_VERSION.to_string(),
            method: "echo".to_string(),
            id: Some(id.to_string()),
            params: None,
        }
    }

    /// A router holding two handlers, i.e. two live mlua references into `lua`.
    fn router_with_handlers(lua: &Lua) -> JsonRpcRouter {
        let mut router = JsonRpcRouter::default();
        for name in ["echo", "ping"] {
            router.add_method(
                name.to_string(),
                lua.create_function(|_, v: mlua::Value| Ok(v)).unwrap(),
                MethodMeta::default(),
            );
        }
        router
    }

    /// The fix's core move: the handlers go while the state is still alive, and
    /// asking twice is free. If this ran only once, the `__gc` backstop firing
    /// after a real mission-end release would double-log and mislead whoever is
    /// reading the log of a sim that died anyway.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn releasing_drops_the_handlers_and_is_idempotent() {
        let _serial = serially();
        rearm();
        let lua = Lua::new();
        let mut router = router_with_handlers(&lua);

        let (handlers, _) = release(&mut router, "mission end");
        assert_eq!(handlers, 2, "both handler references were dropped");
        assert!(released(), "the state is recorded as released");
        assert!(
            router.methods_sorted().is_empty(),
            "nothing is left for __gc to collect"
        );

        let (again, _) = release(&mut router, "mission end");
        assert_eq!(again, 0, "a second release has nothing left to do");
        rearm();
    }

    /// The next mission's `jsonrpc.serve` re-arms, or this DLL would spend the
    /// rest of the DCS session believing the state it serves is already gone.
    #[test]
    fn rearming_clears_the_released_flag_for_the_next_mission() {
        let _serial = serially();
        rearm();
        assert!(!released());
        let mut router = JsonRpcRouter::default();
        release(&mut router, "mission end");
        assert!(released());
        rearm();
        assert!(!released(), "a fresh state starts un-released");
    }

    /// The sentinel's whole contract: dropping it records the teardown, touches
    /// no Lua, and does not panic. `Drop` here is reached from `__gc` inside
    /// `lua_close`, where a panic would abort the process.
    #[test]
    fn dropping_the_sentinel_records_the_teardown_without_touching_lua() {
        let _serial = serially();
        rearm();
        drop(StateGuard);
        assert!(
            released(),
            "a state collected without an explicit release is still recorded"
        );
        rearm();
    }

    /// The mission bridge as it is actually wired: `bootstrap` into a state,
    /// `jsonrpc.serve`, a router of registered handlers, and the sentinel parked
    /// in a global — the shape `lua/mission_init.lua` builds.
    ///
    /// The handler is registered inside a `do` block and watched through a Lua
    /// *weak-valued* table. That is the instrument the lifecycle test turns on:
    /// while the router holds the handler, no collection can reclaim it, and the
    /// weak entry stays. It is the reference into the mission state that used to
    /// be dropped from `__gc` during `lua_close`.
    fn mission_state(port: u16, id: u32) -> Lua {
        let lua = Lua::new();
        let exports = crate::bootstrap(&lua, crate::BridgeKind::Mission, "test").unwrap();
        lua.load(format!(
            r#"
local bridge = ...
STATE = {id}
started = bridge.jsonrpc.serve({{ host = "127.0.0.1", port = {port}, timeout = 30, env = "mission" }})
router = bridge.jsonrpc.JsonRpcRouter.new()
WATCHED = setmetatable({{}}, {{ __mode = "v" }})
do
  local handler = function(p) return {{ state = STATE }} end
  WATCHED.handler = handler
  router:add_method("echo", handler)
end
guard = bridge.jsonrpc.state_guard()
teardown = function(why) return bridge.jsonrpc.teardown(router, why) end
"#
        ))
        .set_name("=teardown-harness")
        .call::<()>(&exports)
        .unwrap();
        lua
    }

    /// Whether the weakly-watched handler survives a full collection. `true`
    /// means something still holds a strong reference to it — and while the
    /// router is the only candidate, that something is Rust holding a reference
    /// into this Lua state.
    ///
    /// Evaluated as its own chunk on purpose: run inside the chunk that created
    /// the handler, the block's register slot could be what keeps it alive and
    /// the instrument would prove nothing.
    fn handler_survives_collection(lua: &Lua) -> bool {
        lua.load(
            "collectgarbage('collect'); collectgarbage('collect'); \
             return WATCHED.handler ~= nil",
        )
        .eval()
        .unwrap()
    }

    /// The whole lifecycle in the order DCS drives it, over ONE set of DLL
    /// statics — which is the only way the interesting parts are reachable: the
    /// mission DLL's `luaopen` re-enters an already-initialised `SERVER` slot on
    /// every mission after the first (card 18, issue #69).
    ///
    /// Driven in process, with no socket: what matters is a request the sim never
    /// drained, and the wire is not part of that. The transports' own handling of
    /// a stranded caller is pinned in `jsonrpc::server`'s tests.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_mission_state_is_released_before_it_dies_and_the_next_one_boots_over_it() {
        let _serial = serially();
        rearm();
        let port = {
            let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            probe.local_addr().unwrap().port()
        };

        // ── First mission ──
        let first = mission_state(port, 1);
        assert!(
            first.globals().get::<bool>("started").unwrap(),
            "the first serve binds the port"
        );
        assert!(
            handler_survives_collection(&first),
            "the router holds the handler, so the collector cannot reclaim it — \
             this is the reference into the mission state that lua_close used to \
             be left to drop"
        );

        // A request queued and never drained: the mission-state pump runs on
        // model time, which stops with the sim, so this is what a mission unload
        // leaves behind.
        let stranded = queue_against_running_server(request("stranded"))
            .expect("a server is running, so the request queues");

        // ── The mission ends, while the state is still whole ──
        let counts: (usize, usize) = first
            .globals()
            .get::<mlua::Function>("teardown")
            .and_then(|f| f.call("mission end"))
            .unwrap();
        assert_eq!(
            counts,
            (1, 1),
            "one handler released, one stranded caller told"
        );

        // (a) Nothing of the bridge's is left in the state DCS is about to close.
        assert!(
            !handler_survives_collection(&first),
            "after the release the collector reclaims the handler — the bridge \
             holds no reference into this state for lua_close to trip over"
        );
        assert_eq!(
            first
                .load("return tostring(router)")
                .eval::<String>()
                .unwrap(),
            "JsonRpcRouter({})",
            "the router is empty, so its own __gc has nothing to drop"
        );

        // (b) The stranded caller was failed truthfully — not left to the 30 s
        // server timeout, and not dropped into a closed channel it can only
        // report as "the bridge went away".
        let answer = stranded
            .blocking_recv()
            .expect("the caller must be answered, not dropped");
        assert_eq!(answer.id, "stranded");
        assert!(answer.result.is_none(), "no result: {answer:?}");
        let error = answer.error.expect("an error envelope");
        assert_eq!(error["code"], JSON_RPC_BRIDGE_TORN_DOWN);
        assert_eq!(error["message"], "bridge torn down");
        assert_eq!(error["data"], "mission end");

        // DCS destroys the state. `Drop` closes it, which runs __gc for every
        // live userdata — the router (now empty) and the sentinel.
        drop(first);

        // ── Second mission, same statics ──
        // (c) `luaopen` re-enters the initialised SERVER slot, reuses the running
        // server, and the fresh state serves through its own router.
        let second = mission_state(port, 2);
        assert!(
            !second.globals().get::<bool>("started").unwrap(),
            "the second state reuses the running server rather than re-binding"
        );
        assert!(
            !released(),
            "serving re-armed the teardown for the new state"
        );
        assert!(
            handler_survives_collection(&second),
            "the fresh state's handler is held by its own router"
        );
        assert_eq!(
            second.load("return STATE").eval::<u32>().unwrap(),
            2,
            "the second state is the one now wired up"
        );

        // ── A state that dies without being asked ──
        // The sentinel's destructor is all that stands between a stranded caller
        // and a 30 s wait when a mission never fires its end event.
        let orphan = queue_against_running_server(request("orphan"))
            .expect("queued against the still-running server");
        drop(second); // no teardown call: lua_close collects the sentinel
        let answer = orphan
            .blocking_recv()
            .expect("the sentinel must fail the queue when lua_close collects it");
        let error = answer.error.expect("an error envelope");
        assert_eq!(error["code"], JSON_RPC_BRIDGE_TORN_DOWN);
        assert_eq!(error["data"], MISSION_STATE_GONE);

        // And a third mission still boots over the same statics, which is what
        // makes the sentinel path survivable rather than terminal.
        let third = mission_state(port, 3);
        assert!(!third.globals().get::<bool>("started").unwrap());
        assert!(!released(), "the third state is armed, not pre-released");
        drop(third);

        // Hand the statics back as they were found, so a sibling test's
        // assertions about "no server running" do not depend on test order.
        retire_server();
        rearm();
    }

    /// The message a stranded caller receives has to say what happened to it —
    /// an editor showing "timed out" for a mission that ended sends the user
    /// looking for a hang that never existed.
    #[test]
    fn the_stranded_callers_reason_names_the_state_that_went_away() {
        assert!(MISSION_STATE_GONE.contains("mission Lua state"));
        assert!(MISSION_STATE_GONE.contains("torn down"));
    }
}
