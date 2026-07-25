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
            let json = match serialize_lua_to_json(&value) {
                Ok(json) => json,
                Err(e) => {
                    return (LuaValue::Nil, format!("toml.encode: {e}")).into_lua_multi(lua);
                }
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod tests {
    use crate::facade::sub_table;
    use mlua::Lua;

    /// Windows-ignored like the rest of the crate's mlua tests: there it needs
    /// DCS's `lua.dll` on the runtime path; on non-Windows the build.rs links
    /// PUC liblua5.1 so Linux CI runs these as ordinary tests (issue #28).
    fn state() -> Lua {
        let lua = Lua::new();
        let toml = sub_table(&lua, "toml", super::register).expect("toml sub");
        lua.globals().set("toml", toml).expect("set toml");
        lua
    }

    /// TOML round-trips through `serde_json::Value`, so the shapes JSON allows
    /// but TOML does not are real failure modes, not theory: a bare array or
    /// scalar at the top level, and a null anywhere. Each must come back as
    /// `(nil, err)` tagged `toml.encode`, because mod config writers hit them
    /// the first time a table has a nil hole in it.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn encode_refuses_the_shapes_toml_has_no_form_for() {
        state()
            .load(
                r#"
                local function refused(out, err)
                  assert(out == nil, "must not encode")
                  assert(err and err:find("toml.encode", 1, true), tostring(err))
                end
                refused(toml.encode({ 1, 2, 3 }))     -- top level must be a table
                refused(toml.encode("bare"))          -- ... not a scalar
                refused(toml.encode({ a = print }))   -- a function has no form at all
                "#,
            )
            .exec()
            .expect("encode failure suite");
    }

    /// The happy path: a keyed table encodes and decodes back to the same
    /// values, including a nested table (a TOML sub-table) — the shape a mod's
    /// `config.toml` actually has.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_keyed_table_round_trips_through_toml() {
        state()
            .load(
                r#"
                local text = assert(toml.encode({ title = "hi", win = { w = 800 } }))
                assert(text:find('title = "hi"', 1, true), text)

                local back = assert(toml.decode(text))
                assert(back.title == "hi" and back.win.w == 800, text)
                "#,
            )
            .exec()
            .expect("round trip");
    }

    /// A malformed document is `(nil, err)`, never a raise: the text comes from
    /// a file the user edited by hand.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn decode_reports_a_parse_error_rather_than_raising() {
        state()
            .load(
                r#"
                local out, err = toml.decode("this is [not toml")
                assert(out == nil, "must not decode")
                assert(err and err:find("toml.decode", 1, true), tostring(err))
                "#,
            )
            .exec()
            .expect("decode failure");
    }
}
