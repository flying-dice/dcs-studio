//! Letting go of a Lua state before DCS destroys it — and letting the state's
//! own lifetime own the server.
//!
//! ## The directive (card 18, third iteration)
//!
//! From the repository owner, as the design driver rather than a hypothesis:
//!
//! > The bridge must respect Lua lifecycles. Resources a Lua-extension DLL
//! > creates are created in the Lua call and handed back to the Lua environment
//! > as mlua userdata, with Lua's GC driving shutdown. The Lua state must never
//! > be used as a mere DLL loader with process-scoped statics — "you get all
//! > sorts of issues" (the card-18 crash being one).
//!
//! Iterations 1 and 2 were live-verified and are kept exactly as verified. What
//! this iteration changes is *ownership*: `jsonrpc.serve` hands the
//! [`JsonRpcServer`] back as userdata, each bridge's boot code parks it in its
//! own state, and there is no longer a DLL-wide server slot or queue slot for a
//! dead state to be reached through. See [`crate::jsonrpc::server`] for the
//! ownership note and card 18 / issue #69 for the evidence trail.
//!
//! ## Two triggers, both still needed
//!
//! * **While the state is alive** — [`release`], driven from the mission state by
//!   its `S_EVENT_MISSION_END` handler (see `lua/mission_init.lua`). This is the
//!   verified fix, and its ORDER is load-bearing and must not be re-arranged:
//!   1. drop every registered handler (each is a live mlua reference into the
//!      state DCS is about to close), so the `__gc` that follows collects an
//!      empty router rather than handing registry references back to a state
//!      already inside `lua_close`;
//!   2. fail every request stranded in the queue with a `-32001` naming the
//!      cause — this reads the *running* server's queue, which is why it comes
//!      before the stop and not after (40-odd real callers per unload in the live
//!      runs);
//!   3. stop the listener and wait, bounded, for the actix `System` thread to
//!      leave — the half iteration 2 added, after 6 crashes where the mission
//!      bridge's worker had accepted connections and 4 clean runs where it had
//!      not.
//!
//!   Doing it here rather than in `__gc` is still correct and still cheaper: the
//!   state is whole, so dropping Lua handles is ordinary work, and the sim is
//!   between frames rather than mid-`lua_close`.
//!
//! * **While the state is closing** — [`JsonRpcServer`]'s own `Drop`. Lua 5.1
//!   runs `__gc` for every live userdata during `lua_close`, so a mission that
//!   never fires `S_EVENT_MISSION_END` now still has its queue failed *and its
//!   server stopped*, because the server is that userdata. That closes iteration
//!   2's one documented gap — the old sentinel could only fail the queue, so an
//!   event-less mission kept its listener across the unload and the next mission
//!   inherited it. There is nothing left to inherit.
//!
//!   The cost is bounded on purpose: `Drop` from `__gc` runs on the sim thread
//!   with the state already dying, so it spends the tight `COLLECTED_STOP`
//!   budget, touches no Lua, and cannot panic. The full budget is only ever
//!   spent by the explicit path.
//!
//! Nothing here needs arming or re-arming any more: a new mission gets a new
//! state, a new server userdata and a new router, so there is no stale DLL flag
//! for it to inherit.
//!
//! ## The GUI bridge
//!
//! Same shape, unchanged behaviour: the hook parks its server userdata in its
//! frame callbacks, and the `GameGUI` state is never destroyed before the process
//! exits — so that server spans the process exactly as before. An explicit
//! [`release`] evaluated against it still refuses to stop the listener, by the
//! server's own `env` identity rather than by trusting the caller: it is the
//! editor's only way in at the main menu.

use crate::jsonrpc::router::JsonRpcRouter;
use crate::jsonrpc::server::JsonRpcServer;
use log::info;

/// What the bridge tells a stranded caller when its Lua state went away without
/// asking — the `Drop`-from-`lua_close` path.
pub(crate) const STATE_GONE: &str =
    "the Lua state that would have answered this request was torn down";

/// What [`release`] did, in the order it did it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Released {
    /// Handlers dropped from the router — live mlua references into the state.
    pub(crate) handlers: usize,
    /// Stranded callers told the truth instead of left to time out.
    pub(crate) failed: usize,
    /// The port whose listener was stopped, or `None` when there was nothing to
    /// stop (the GUI bridge, or a state released twice).
    pub(crate) stopped_port: Option<u16>,
    /// Whether the stopped server's thread was observed to leave its actix
    /// `System` within the budget. `true` when there was nothing to stop.
    pub(crate) system_exited: bool,
}

impl mlua::IntoLuaMulti for Released {
    fn into_lua_multi(self, lua: &mlua::Lua) -> mlua::Result<mlua::MultiValue> {
        (
            self.handlers,
            self.failed,
            self.stopped_port,
            self.system_exited,
        )
            .into_lua_multi(lua)
    }
}

/// Release everything this bridge holds in `router`'s Lua state, while that state
/// is still alive, and stop serving from outside it.
///
/// The three steps and their order are documented at the module head and are
/// load-bearing — live verification pinned this sequence, so do not re-arrange
/// it. Only the MISSION bridge's listener is stopped; see the module head.
///
/// Idempotent: a mission that fires its end event and *then* gets collected runs
/// the equivalent twice, and the second run has nothing left to do.
pub(crate) fn release(
    server: &mut JsonRpcServer,
    router: &mut JsonRpcRouter,
    reason: &str,
) -> Released {
    // What a panic with no protected frame would be blamed on from here. An
    // atomic store and nothing else, because the handler that reads it runs on a
    // thread that is about to die (see `lua_panic`), and because the next line
    // starts dropping live mlua references into a state DCS is about to close —
    // which is the frame worth naming if the process ends inside it.
    crate::lua_panic::enter(crate::lua_panic::Phase::Teardown);

    // 1. The Lua handles, while the state can still take the drops.
    let handlers = router.release();
    // 2. The queue, read off the still-running server.
    let failed = server.fail_queued(reason);
    // 3. The listener and its worker — mission bridge only.
    let stopped = if server.serves_mission_state() {
        server.stop(crate::jsonrpc::server::EXPLICIT_STOP)
    } else {
        None
    };

    info!(
        "teardown ({reason}): released {handlers} Lua handler(s), \
         failed {failed} queued request(s)"
    );
    match stopped {
        Some(stop) => info!(
            "teardown ({reason}): stopped the mission HTTP server on port {} \
             (server thread exited: {}) — the next mission binds a fresh one",
            stop.port, stop.system_exited
        ),
        None if server.serves_mission_state() => {
            info!("teardown ({reason}): the mission HTTP server had already stopped");
        }
        None => info!(
            "teardown ({reason}): the GUI bridge's server is left serving — its \
             state outlives every mission"
        ),
    }

    // The GUI bridge's state outlives every mission and goes straight back to
    // serving, so leaving it stamped `Teardown` would misname every panic for
    // the rest of the process. The mission bridge's state is about to be closed;
    // `Teardown` is the truthful last thing it was doing.
    if !server.serves_mission_state() {
        crate::lua_panic::enter(crate::lua_panic::Phase::Ready);
    }

    Released {
        handlers,
        failed,
        stopped_port: stopped.map(|stop| stop.port),
        system_exited: stopped.is_none_or(|stop| stop.system_exited),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod tests {
    use super::{release, STATE_GONE};
    use crate::jsonrpc::router::{JsonRpcRouter, MethodMeta};
    use crate::jsonrpc::server::{free_port, health_over_tcp, queue_against, JsonRpcServer};
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

    /// The mission bridge as it is actually wired: `bootstrap` into a state,
    /// `jsonrpc.serve`, a router of registered handlers, and the server userdata
    /// parked where the pumps reach it — the shape `lua/mission_init.lua` builds.
    ///
    /// The handler is registered inside a `do` block and watched through a Lua
    /// *weak-valued* table. That is the instrument the lifecycle test turns on:
    /// while the router holds the handler, no collection can reclaim it, and
    /// after the release the same collection does. It is the reference into the
    /// mission state that used to be dropped from `__gc` during `lua_close`.
    fn mission_state(port: u16, id: u32) -> Lua {
        let lua = Lua::new();
        let exports = crate::bootstrap(&lua, crate::BridgeKind::Mission, "test").unwrap();
        lua.load(format!(
            r#"
local bridge = ...
STATE = {id}
-- serve() hands back userdata that OWNS the server; this state parks it.
server = bridge.jsonrpc.serve({{ host = "127.0.0.1", port = {port}, timeout = 30, env = "mission" }})
router = bridge.jsonrpc.JsonRpcRouter.new()
WATCHED = setmetatable({{}}, {{ __mode = "v" }})
do
  local handler = function(p) return {{ state = STATE }} end
  WATCHED.handler = handler
  router:add_method("echo", handler)
end
pump = function() return server:process_rpc(router) end
teardown = function(why) return server:teardown(router, why) end
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

    /// The verified fix's core move, at the Rust level: the handlers go while the
    /// state is still alive, the queue is answered, the listener stops, and
    /// asking twice is free.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn releasing_drops_the_handlers_and_is_idempotent() {
        let _serial = serially();
        let lua = Lua::new();
        let mut router = router_with_handlers(&lua);
        let port = free_port();
        let mut server = JsonRpcServer::new(
            serde_json::from_str(&format!(
                r#"{{"host":"127.0.0.1","port":{port},"env":"mission"}}"#
            ))
            .unwrap(),
        )
        .expect("a free port binds");

        // The handlers are live and answering right up to the release — which is
        // what makes dropping them the interesting act rather than a bookkeeping
        // one.
        let answered: String = router
            .get_method("echo")
            .expect("registered")
            .call("alive")
            .unwrap();
        assert_eq!(answered, "alive");

        let released = release(&mut server, &mut router, "mission end");
        assert_eq!(released.handlers, 2, "both handler references were dropped");
        assert_eq!(released.stopped_port, Some(port), "the listener stopped");
        assert!(
            router.methods_sorted().is_empty(),
            "nothing is left for __gc to collect"
        );

        let again = release(&mut server, &mut router, "mission end");
        assert_eq!(again.handlers, 0, "a second release has nothing left to do");
        assert_eq!(again.stopped_port, None, "and nothing left to stop");
    }

    /// The whole lifecycle in the order DCS drives it, over ONE DLL image — and
    /// the decisive assertion of this iteration is (0b): dropping the Lua STATE,
    /// with a live serving server and **no event fired at all**, stops the
    /// server. That is what Lua-owned lifecycle buys, and what iteration 2's
    /// sentinel could not do.
    ///
    /// Real connections ARE served here, over TCP, because "had accepted
    /// connections" is the condition the crash tracked.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_mission_state_is_released_before_it_dies_and_the_next_one_boots_over_it() {
        let _serial = serially();
        let port = free_port();

        // ── First mission: released explicitly, as S_EVENT_MISSION_END does ──
        let first = mission_state(port, 1);
        assert!(
            health_over_tcp(port)
                .expect("the mission bridge must serve")
                .contains("dcs-studio-mission"),
            "a real connection is accepted during the mission"
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
        let stranded = queue_from_lua(&first, request("stranded"));

        let released: (usize, usize, Option<u16>, bool) = first
            .globals()
            .get::<mlua::Function>("teardown")
            .and_then(|f| f.call("mission end"))
            .unwrap();
        assert_eq!(
            released,
            (1, 1, Some(port), true),
            "one handler released, one stranded caller told, the listener stopped \
             and its System thread observed leaving"
        );

        // (0a) The serving apparatus is GONE, not merely idle.
        assert!(
            health_over_tcp(port).is_err(),
            "the mission bridge's listener must not outlive the mission state"
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

        // (b) The stranded caller was failed truthfully — not left to the server
        // timeout, and not dropped into a closed channel it can only report as
        // "the bridge went away".
        let answer = stranded
            .blocking_recv()
            .expect("the caller must be answered, not dropped");
        assert_eq!(answer.id, "stranded");
        assert!(answer.result.is_none(), "no result: {answer:?}");
        let error = answer.error.expect("an error envelope");
        assert_eq!(error["code"], JSON_RPC_BRIDGE_TORN_DOWN);
        assert_eq!(error["message"], "bridge torn down");
        assert_eq!(error["data"], "mission end");

        drop(first);

        // ── Second mission over the same DLL image: binds fresh and serves ──
        let second = mission_state(port, 2);
        assert!(
            health_over_tcp(port)
                .expect("the next mission must be served too")
                .contains("dcs-studio-mission"),
            "a fresh server serves on the same port"
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

        // (0b) THE DECISIVE ONE. No teardown call, no event, nothing: just the
        // Lua state dying, as a mission that never fires S_EVENT_MISSION_END
        // dies. lua_close runs __gc for the server userdata, whose Drop stops
        // the listener. Under iteration 2 this connect still succeeded and the
        // next mission inherited that worker.
        let orphan = queue_from_lua(&second, request("orphan"));
        drop(second);
        assert!(
            health_over_tcp(port).is_err(),
            "closing the Lua state must stop the server it owned, with no event \
             fired — this is the gap Lua-owned lifecycle closes"
        );
        // (c) And its stranded caller is told the truth rather than hanging.
        let answer = orphan
            .blocking_recv()
            .expect("a request stranded at close must be answered, not left to hang");
        let error = answer.error.expect("an error envelope");
        assert_eq!(error["code"], JSON_RPC_BRIDGE_TORN_DOWN);
        assert_eq!(error["data"], STATE_GONE);

        // ── Third mission: the port is free again, so a state can still boot ──
        let third = mission_state(port, 3);
        assert!(
            health_over_tcp(port)
                .expect("a third mission must still be served")
                .contains("dcs-studio-mission"),
            "an orphaned state's server released its port for the next mission"
        );
        drop(third);
    }

    /// Queue a request against the server this Lua state owns, as a transport
    /// would. Reaches it through the userdata, because that is now the only way
    /// in — there is no queue static to go behind Lua's back with.
    fn queue_from_lua(
        lua: &Lua,
        request: JsonRpcRequest,
    ) -> tokio::sync::oneshot::Receiver<crate::jsonrpc::JsonRpcResponse> {
        let server = lua
            .globals()
            .get::<mlua::AnyUserData>("server")
            .expect("the state parks its server");
        let server = server.borrow::<JsonRpcServer>().expect("a JsonRpcServer");
        queue_against(&server, request).expect("the server queues it")
    }

    /// The message a stranded caller receives has to say what happened to it —
    /// an editor showing "timed out" for a mission that ended sends the user
    /// looking for a hang that never existed.
    #[test]
    fn the_stranded_callers_reason_names_the_state_that_went_away() {
        assert!(STATE_GONE.contains("Lua state"));
        assert!(STATE_GONE.contains("torn down"));
    }
}
