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
                "Bind a server. `config = { host = string, port = number, timeout? = number, env? = string }`. \
                 The same thing `serve` does — prefer `serve`, which is what both bridges' boot code calls.",
            )
            .method(
                "process_rpc",
                &[p("router", &router_ty)],
                &[r("boolean")],
                "Drain this server's queued requests, dispatching each through `router`. Call once per simulation frame.",
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
