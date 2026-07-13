pub mod router;
pub mod server;

use crate::facade::{p, p_opt, r, r_named, Sub};
use crate::jsonrpc::router::JsonRpcRouter;
use crate::jsonrpc::server::JsonRpcServer;
use mlua::prelude::LuaResult;
use mlua::{IntoLuaMulti, UserDataRef};
use std::ops::Deref;

// Envelope types are shared with the editor side via dcs-bridge-client — single source of truth.
pub use crate::protocol::{JsonRpcError, JsonRpcRequest, JsonRpcResponse, JSON_RPC_VERSION};

pub const JSON_RPC_METHOD_NOT_FOUND: i32 = -32601;
pub const JSON_RPC_INTERNAL_ERROR: i32 = -32603;

/// Register the `jsonrpc` sub-namespace: the `JsonRpcServer` and
/// `JsonRpcRouter` userdata proxies, with their `.d.lua` types recorded.
pub fn register(sub: &mut Sub) -> LuaResult<()> {
    sub.proxy::<JsonRpcServer>(
        "JsonRpcServer",
        "The native WebSocket/HTTP JSON-RPC server inside the DLL.",
        |ud| {
            ud.constructor(
                "new",
                &[p("config", "table")],
                &[r("dcs_studio.jsonrpc.JsonRpcServer")],
                "Bind a server. `config = { host = string, port = number, timeout? = number }`.",
            )
            .method(
                "process_rpc",
                &[p("router", "dcs_studio.jsonrpc.JsonRpcRouter")],
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
        "process_queue",
        &[p("router", "dcs_studio.jsonrpc.JsonRpcRouter")],
        &[r_named("boolean", "served")],
        "Drain the running server's queued requests through `router`, callable \
         from ANY Lua state in the process (not just the one that owns the \
         server). The mission-state debugger pumps the editor's requests with \
         this while a paused chunk holds the sim thread. Returns false when no \
         server is running.",
        |lua, router: UserDataRef<JsonRpcRouter>| {
            server::process_global_queue(lua, router.deref())?.into_lua_multi(lua)
        },
    )?;

    sub.proxy::<JsonRpcRouter>(
        "JsonRpcRouter",
        "A method-name → Lua-handler table for JSON-RPC dispatch.",
        |ud| {
            ud.constructor(
                "new",
                &[],
                &[r("dcs_studio.jsonrpc.JsonRpcRouter")],
                "Create an empty router.",
            )
            .method(
                "add_method",
                &[p("name", "string"), p("handler", "fun(params: any): any")],
                &[],
                "Register `handler` under JSON-RPC method `name`.",
            );
        },
    )?;

    Ok(())
}
