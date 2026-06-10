pub mod router;
pub mod server;

use crate::jsonrpc::router::JsonRpcRouter;
use crate::jsonrpc::server::JsonRpcServer;
use mlua::prelude::{LuaResult, LuaTable};
use mlua::Lua;

// Envelope types are shared with the editor side via dcs-bridge-client — single source of truth.
pub use dcs_bridge_client::protocol::{JsonRpcError, JsonRpcRequest, JsonRpcResponse, JSON_RPC_VERSION};

pub const JSON_RPC_METHOD_NOT_FOUND: i32 = -32601;
pub const JSON_RPC_INTERNAL_ERROR: i32 = -32603;
// const JSON_RPC_PARSE_ERROR: i32 = -32700;
// const JSON_RPC_INVALID_REQUEST: i32 = -32600;
// const JSON_RPC_INVALID_PARAMS: i32 = -32602;

pub fn inject_module(lua: &Lua, table: &LuaTable) -> LuaResult<()> {
    let m = lua.create_table()?;

    m.set("JsonRpcServer", lua.create_proxy::<JsonRpcServer>()?)?;
    m.set("JsonRpcRouter", lua.create_proxy::<JsonRpcRouter>()?)?;

    table.set("jsonrpc", m)?;

    Ok(())
}
