//! The `json` sub-namespace: JSON encode/decode, registered + type-recorded
//! through the binding facade.

use crate::facade::{p, p_opt, r_named, Sub};
use crate::lua_utils::{opt_bool, serialize_lua_to_json, to_json_string};
use log::debug;
use mlua::prelude::{LuaTable, LuaValue};
use mlua::{IntoLuaMulti, Lua, LuaSerdeExt, Result};
use serde_json::{from_str, Value};

/// Register `json.encode` / `json.safe_encode` / `json.decode` on `sub`.
pub fn register(sub: &mut Sub) -> Result<()> {
    sub.func(
        "encode",
        &[p("value", "any"), p_opt("opts", "table")],
        &[r_named("string?", "json"), r_named("string?", "err")],
        "Encode a Lua value to a JSON string. `opts.pretty = true` indents the \
         output. Returns (nil, err) when the value is not representable \
         (NaN/Inf, a function, …).",
        |lua: &Lua, (lua_value, opts): (LuaValue, Option<LuaTable>)| {
            match to_json_string(&lua_value, opt_bool(&opts, "pretty")) {
                Ok(json_string) => json_string.into_lua_multi(lua),
                Err(e) => (LuaValue::Nil, e.to_string()).into_lua_multi(lua),
            }
        },
    )?;

    sub.func(
        "safe_encode",
        &[p("value", "any")],
        &[r_named("string?", "json"), r_named("string?", "err")],
        "Encode a Lua value to JSON, coercing sim-unsafe values (NaN/Inf → null, \
         non-UTF-8 strings lossily) instead of failing. Never panics.",
        |lua: &Lua, lua_value: LuaValue| match serialize_lua_to_json(&lua_value) {
            Some(value) => match serde_json::to_string(&value) {
                Ok(json_string) => json_string.into_lua_multi(lua),
                Err(e) => (LuaValue::Nil, e.to_string()).into_lua_multi(lua),
            },
            None => (
                LuaValue::Nil,
                format!("Unsupported Lua value for JSON serialization {lua_value:?}"),
            )
                .into_lua_multi(lua),
        },
    )?;

    sub.func(
        "decode",
        &[p("json", "string")],
        &[r_named("any?", "value"), r_named("string?", "err")],
        "Decode a JSON string into a Lua value. Returns (nil, err) on a parse error.",
        |lua: &Lua, value: String| {
            debug!("json.decode: {value}");
            match from_str::<Value>(&value) {
                Ok(value) => lua.to_value(&value).into_lua_multi(lua),
                Err(e) => (LuaValue::Nil, e.to_string()).into_lua_multi(lua),
            }
        },
    )?;

    Ok(())
}
