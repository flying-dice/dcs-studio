pub mod openrpc;
pub mod router;
pub mod server;
pub mod teardown;

use crate::facade::{p, p_opt, r, r_named, Sub};
use crate::jsonrpc::router::JsonRpcRouter;
use crate::jsonrpc::server::JsonRpcServer;
use mlua::prelude::LuaResult;
use mlua::{ExternalError, IntoLuaMulti};

// The JSON-RPC envelope types (defined in `crate::protocol`) — this crate is the
// single source of truth for the wire shapes the editor side speaks to.
pub use crate::protocol::{JsonRpcError, JsonRpcRequest, JsonRpcResponse, JSON_RPC_VERSION};

pub const JSON_RPC_METHOD_NOT_FOUND: i32 = -32601;
pub const JSON_RPC_INTERNAL_ERROR: i32 = -32603;

/// Implementation-defined server error (the JSON-RPC 2.0 `-32000..-32099` band):
/// the Lua state that would have answered this request is being destroyed, so
/// nothing can ever answer it. Distinguishable from a plain internal error on
/// purpose — the editor should treat it as "the mission ended", not "the bridge
/// is broken".
pub const JSON_RPC_BRIDGE_TORN_DOWN: i32 = -32001;

/// Implementation-defined server error (the same `-32000..-32099` band): the
/// transport is healthy and the request was understood, but the Lua-side pump
/// that would dispatch it has not drained this server's queue for long enough
/// that queueing the request would only end in the server's own timeout.
///
/// Card 17's whole finding, in one code. A held mission breakpoint stops the GUI
/// bridge's `onSimulationFrame` drain while its socket keeps answering `/health`
/// in 1-2 ms, so every `/rpc` burned the full 30 s deadline for as long as the
/// user inspected state. There is nothing to repair there — only something to
/// report — so the request is refused immediately with the reason instead.
/// Distinguishable from [`JSON_RPC_BRIDGE_TORN_DOWN`] on purpose: nothing has
/// gone away, and the very next frame will serve again.
///
/// The name records the first cause, not the only one. This code now carries
/// TWO refusals, told apart by the message rather than by the code:
///
/// - `"sim not pumping"` — the staleness refusal described above.
/// - `"queue full"` — the queue is at its cap and a request arriving at a full
///   one is answered rather than queued.
///
/// One code for both is deliberate. They are the same thing to a caller: a
/// transient, bridge-side back-pressure refusal of a request that was perfectly
/// well formed, where the remedy is to retry rather than to change anything. A
/// client that wants to tell them apart reads the message; a client that only
/// wants to know whether to retry does not have to.
pub const JSON_RPC_PUMP_STALLED: i32 = -32002;

/// One turnstile for every test in this crate that binds a server. Since card
/// 18's third iteration there are no server statics to collide over, but the
/// *ports* still are shared: libtest runs a binary's tests in parallel, several
/// of these tests assert that a particular port is refused after a stop, and a
/// sibling rebinding meanwhile would answer about someone else's listener.
#[cfg(test)]
pub(crate) fn serially() -> std::sync::MutexGuard<'static, ()> {
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
    SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Register the `jsonrpc` sub-namespace: the `JsonRpcServer` and
/// `JsonRpcRouter` userdata proxies plus the free `serve` entry point, with
/// their `.d.lua` types recorded.
pub fn register(sub: &mut Sub) -> LuaResult<()> {
    let server_ty = sub.qualified("JsonRpcServer");
    let router_ty = sub.qualified("JsonRpcRouter");

    sub.proxy::<JsonRpcServer>(
        "JsonRpcServer",
        "The native WebSocket/HTTP JSON-RPC server inside the DLL, owned by the Lua state that created it.",
        |ud| {
            ud.constructor(
                "new",
                &[p("config", "table")],
                &[r(&server_ty)],
                "Bind a server. `config = { host = string, port = number, timeout? = number, \
                 env? = string, pump_stale_ms? = number }`. \
                 timeout is the request deadline in seconds (default 30; 0 means effectively \
                 never, for interactive debugging). \
                 pump_stale_ms is how long this server's queue may go undrained before arriving \
                 requests are refused with -32002 'sim not pumping' instead of queueing into the \
                 request timeout (default 2000; 0 disables). \
                 -32002 also carries 'queue full', the bridge's other refusal: the queue holds 256 \
                 entries, and a request arriving at a full one is answered rather than queued. \
                 A NOTIFICATION is never refused this way, because it has no id to answer to — at \
                 a full queue the oldest queued notification is dropped to make room for it, and \
                 if every entry is a request with a caller waiting then the arriving notification \
                 is the one dropped. Either way the drop is logged at warn and reported nowhere \
                 else. \
                 The same thing `serve` does — prefer `serve`, which is what both bridges' boot code calls.",
            )
            .method(
                "process_rpc",
                &[p("router", &router_ty)],
                &[r("boolean")],
                "Drain this server's queued requests, dispatching each through `router`. Call once per simulation frame. \
                 Each call also stamps this server's pump-liveness clock, which is what /health reports and what keeps \
                 arriving requests from being refused as un-dispatchable — so the debugger's pause loop, which pumps \
                 through this method, keeps its own bridge serving while it holds the sim thread.",
            )
            .method(
                "stop",
                &[],
                &[r_named("boolean", "stopped"), r_named("boolean", "system_exited")],
                "Stop serving now, cutting open connections, and wait (bounded) for the server's \
                 thread to leave its actix System. Returns false for `stopped` if it had already \
                 stopped. Idempotent; the same thing dropping the userdata does.",
            )
            .method(
                "teardown",
                &[p("router", &router_ty), p_opt("reason", "string")],
                &[
                    r_named("number", "handlers_released"),
                    r_named("number", "requests_failed"),
                    r_named("number|nil", "stopped_port"),
                    r_named("boolean", "system_exited"),
                ],
                "End this Lua state's use of the bridge while the state is still ALIVE, in order: \
                 drop every handler registered on `router` (each is a live reference into this \
                 state), fail every request stranded in this server's queue with a truthful error, \
                 then stop the server. Call it from the state's own end-of-life signal — the \
                 mission bridge does, on S_EVENT_MISSION_END — so DCS's lua_close finds nothing of \
                 ours left to collect and nothing of ours still serving. The GUI bridge's listener \
                 is left up (its state outlives every mission). Idempotent, and dropping the \
                 userdata does the server half anyway.",
            );
        },
    )?;

    sub.func(
        "serve",
        &[p("config", "table")],
        &[r_named(&server_ty, "server")],
        "Bind this bridge's JSON-RPC server and return it as userdata that OWNS it. \
         `config` as for JsonRpcServer.new. KEEP THE RETURNED VALUE REACHABLE for as long \
         as the bridge should serve: the server stops when the Lua state stops holding it, \
         including when DCS destroys the state (lua_close collects the userdata). Each Lua \
         state gets its own server — nothing is shared through the DLL between mission loads.",
        |lua, config: server::ServerConfig| {
            server::ensure_server(config)
                .map_err(|e| e.to_string().into_lua_err())?
                .into_lua_multi(lua)
        },
    )?;

    sub.proxy::<JsonRpcRouter>(
        "JsonRpcRouter",
        "A method-name → Lua-handler table for JSON-RPC dispatch.",
        |ud| {
            ud.constructor("new", &[], &[r(&router_ty)], "Create an empty router.")
                .method(
                    "add_method",
                    &[
                        p("name", "string"),
                        p("handler", "fun(params: any): any"),
                        p_opt("meta", "table"),
                    ],
                    &[],
                    "Register `handler` under JSON-RPC method `name`. Optional `meta` \
                 feeds rpc.discover: { description? = string, params? = { { name = \
                 string, type? = string, required? = boolean, description? = string }, ... } }.",
                );
        },
    )?;

    Ok(())
}
