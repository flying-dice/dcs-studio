pub mod openrpc;
pub mod router;
pub mod server;
pub mod teardown;

use crate::facade::{p, p_opt, r, r_named, Sub};
use crate::jsonrpc::router::JsonRpcRouter;
use crate::jsonrpc::server::JsonRpcServer;
use mlua::prelude::LuaResult;
use mlua::{ExternalError, IntoLuaMulti, UserDataRef, UserDataRefMut};

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

/// One turnstile for every test in this crate that touches the DLL-wide server,
/// request queue or teardown flag. libtest runs a binary's tests in parallel,
/// and those statics are deliberately one-per-DLL: two tests binding a server or
/// arming a teardown at once would each see the other's moves, and an assertion
/// about "the running server" would be answering about someone else's.
#[cfg(test)]
pub(crate) fn serially() -> std::sync::MutexGuard<'static, ()> {
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
    SERIAL
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Register the `jsonrpc` sub-namespace: the `JsonRpcServer` and
/// `JsonRpcRouter` userdata proxies plus the free `serve`/`process_queue`
/// functions, with their `.d.lua` types recorded.
pub fn register(sub: &mut Sub) -> LuaResult<()> {
    let server_ty = sub.qualified("JsonRpcServer");
    let router_ty = sub.qualified("JsonRpcRouter");

    sub.proxy::<JsonRpcServer>(
        "JsonRpcServer",
        "The native WebSocket/HTTP JSON-RPC server inside the DLL.",
        |ud| {
            ud.constructor(
                "new",
                &[p("config", "table")],
                &[r(&server_ty)],
                "Bind a server. `config = { host = string, port = number, timeout? = number, env? = string }`.",
            )
            .method(
                "process_rpc",
                &[p("router", &router_ty)],
                &[r("boolean")],
                "Drain the queued requests, dispatching each through `router`. Call once per simulation frame.",
            )
            .method(
                "stop",
                &[p_opt("graceful", "boolean")],
                &[],
                "Stop the server (gracefully by default).",
            );
        },
    )?;

    sub.func(
        "serve",
        &[p("config", "table")],
        &[r_named("boolean", "started")],
        "Start this DLL's server if none is running, else reuse the running \
         one (dropping any requests stranded in its queue). Idempotent across \
         mission reloads — the DLL image and its server outlive each mission's \
         Lua state. `config` as for JsonRpcServer.new. Returns true when the \
         server was newly started.",
        |lua, config: server::ServerConfig| {
            server::ensure_server(config)
                .map_err(|e| e.to_string().into_lua_err())?
                .into_lua_multi(lua)
        },
    )?;

    sub.func(
        "process_queue",
        &[p("router", &router_ty)],
        &[r_named("boolean", "served")],
        "Drain the running server's queued requests through `router`, callable \
         from anywhere in this DLL's Lua state (not just the holder of the \
         server userdata). The debugger pumps the editor's requests with this \
         while a paused chunk holds the sim thread. Returns false when no \
         server is running.",
        |lua, router: UserDataRef<JsonRpcRouter>| {
            server::process_global_queue(lua, &router).into_lua_multi(lua)
        },
    )?;

    register_teardown(sub, &router_ty)?;

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

/// The teardown surface: releasing a Lua state before DCS destroys it, and the
/// sentinel that notices when DCS destroys one without being asked. Split out of
/// [`register`] only to keep that function readable.
///
/// Registered on BOTH bridges because the whole `jsonrpc` namespace is shared,
/// and **inert on the GUI bridge by design**: the `GameGUI` state is created once
/// at DCS start and lives until the process exits, so it has no teardown to run
/// and the hook parks no sentinel. Only `dcs_studio_mission` uses these — and
/// `teardown`'s server stop refuses the GUI bridge's server even if someone
/// evaluates it there, since stopping it would cut the editor off for the rest of
/// the DCS session.
fn register_teardown(sub: &mut Sub, router_ty: &str) -> LuaResult<()> {
    sub.func(
        "teardown",
        &[p("router", router_ty), p_opt("reason", "string")],
        &[
            r_named("number", "handlers_released"),
            r_named("number", "requests_failed"),
            r_named("number|nil", "stopped_port"),
        ],
        "Release everything this DLL holds in the CURRENT Lua state, while that \
         state is still alive, and stop serving from outside it: drop every \
         handler registered on `router` (each one is a live reference into this \
         state), fail every request stranded in the server's queue with a \
         truthful error, and stop the MISSION bridge's HTTP server so its actix \
         worker and the connections it accepted do not outlive the state either \
         (the GUI bridge's server is left alone — its state is never destroyed). \
         Call it from the state's own end-of-life signal — the mission bridge \
         does, on S_EVENT_MISSION_END — so DCS's lua_close finds nothing of ours \
         left to collect and nothing of ours still serving. Returns the port that \
         was stopped, or nil if there was no mission server to stop. Idempotent.",
        |lua, (mut router, reason): (UserDataRefMut<JsonRpcRouter>, Option<String>)| {
            let reason = reason.unwrap_or_else(|| "requested".to_string());
            teardown::release(&mut router, &reason).into_lua_multi(lua)
        },
    )?;

    sub.func(
        "state_guard",
        &[],
        &[r_named("userdata", "guard")],
        "Create the teardown sentinel for this Lua state. Keep the returned \
         userdata reachable (the mission bridge parks it in a global): when DCS \
         destroys the state, Lua's lua_close collects it and the DLL fails every \
         stranded request. It is the BACKSTOP for a state that dies without \
         calling `teardown` — it cannot drop Lua handles, because by then \
         touching Lua is exactly what must not happen, and it does not stop the \
         server either, because blocking inside lua_close on the sim thread would \
         trade a crash for a freeze.",
        |lua, ()| teardown::StateGuard.into_lua_multi(lua),
    )?;

    Ok(())
}
