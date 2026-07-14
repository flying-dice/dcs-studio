pub mod router;
pub mod server;

use crate::facade::{p, p_opt, r, r_named, Sub};
use crate::jsonrpc::router::JsonRpcRouter;
use crate::jsonrpc::server::JsonRpcServer;
use mlua::prelude::LuaResult;
use mlua::{ExternalError, IntoLuaMulti, UserDataRef};
use std::ops::Deref;

// Envelope types are shared with the editor side via dcs-bridge-client — single source of truth.
pub use crate::protocol::{JsonRpcError, JsonRpcRequest, JsonRpcResponse, JSON_RPC_VERSION};

pub const JSON_RPC_METHOD_NOT_FOUND: i32 = -32601;
pub const JSON_RPC_INTERNAL_ERROR: i32 = -32603;

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
            server::process_global_queue(lua, router.deref())?.into_lua_multi(lua)
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
