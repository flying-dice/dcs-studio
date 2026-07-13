//! The `toml` sub-namespace: TOML ⇄ Lua, bridged through `serde_json::Value`
//! (TOML and JSON both (de)serialize it, so one value type spans both codecs).
//! Registered + type-recorded through the binding facade.

use crate::facade::{p, r_named, Sub};
use crate::lua_utils::serialize_lua_to_json;
use mlua::prelude::LuaValue;
use mlua::{IntoLuaMulti, Lua, LuaSerdeExt, Result};

/// Register `toml.encode` / `toml.decode` on `sub`.
pub fn register(sub: &mut Sub) -> Result<()> {
    sub.func(
        "encode",
        &[p("value", "table")],
        &[r_named("string?", "toml"), r_named("string?", "err")],
        "Encode a Lua table to a TOML string (sim-safe: NaN/Inf → null, non-UTF-8 \
         lossy). The TOML top level must be a table; a bare array/scalar or a \
         null value returns (nil, err).",
        |lua: &Lua, value: LuaValue| {
            let Some(json) = serialize_lua_to_json(&value) else {
                return (LuaValue::Nil, "toml.encode: unsupported Lua value".to_string())
                    .into_lua_multi(lua);
            };
            match toml::to_string(&json) {
                Ok(text) => text.into_lua_multi(lua),
                Err(e) => (LuaValue::Nil, format!("toml.encode: {e}")).into_lua_multi(lua),
            }
        },
    )?;

    sub.func(
        "decode",
        &[p("toml", "string")],
        &[r_named("table?", "value"), r_named("string?", "err")],
        "Decode a TOML string into a Lua table. Returns (nil, err) on a parse error.",
        |lua: &Lua, text: String| match toml::from_str::<serde_json::Value>(&text) {
            Ok(value) => lua.to_value(&value).into_lua_multi(lua),
            Err(e) => (LuaValue::Nil, format!("toml.decode: {e}")).into_lua_multi(lua),
        },
    )?;

    Ok(())
}
