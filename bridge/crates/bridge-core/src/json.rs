//! The `json` sub-namespace: JSON encode/decode, registered + type-recorded
//! through the binding facade.

use crate::facade::{p, p_opt, r_named, Sub};
use crate::lua_utils::{opt_bool, to_json_string, to_safe_json_string};
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
        |lua: &Lua, (lua_value, opts): (LuaValue, Option<LuaTable>)| match to_json_string(
            &lua_value,
            opt_bool(opts.as_ref(), "pretty"),
        ) {
            Ok(json_string) => json_string.into_lua_multi(lua),
            Err(e) => (LuaValue::Nil, e.to_string()).into_lua_multi(lua),
        },
    )?;

    sub.func(
        "safe_encode",
        &[p("value", "any")],
        &[r_named("string?", "json"), r_named("string?", "err")],
        "Encode a Lua value to JSON, coercing sim-unsafe values (NaN/Inf → null, \
         non-UTF-8 strings lossily) instead of failing. Never panics.",
        |lua: &Lua, lua_value: LuaValue| match to_safe_json_string(&lua_value, false) {
            Ok(json_string) => json_string.into_lua_multi(lua),
            Err(e) => (LuaValue::Nil, e).into_lua_multi(lua),
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod tests {
    use crate::facade::sub_table;
    use mlua::Lua;

    /// A Lua state with the `json` surface bound as the global `json`.
    /// Windows-ignored like the rest of the crate's mlua tests: there it needs
    /// DCS's `lua.dll` on the runtime path; on non-Windows the build.rs links
    /// PUC liblua5.1 so Linux CI runs these as ordinary tests (issue #28).
    fn state() -> Lua {
        let lua = Lua::new();
        let json = sub_table(&lua, "json", super::register).expect("json sub");
        lua.globals().set("json", json).expect("set json");
        lua
    }

    /// `encode` is the strict codec: it refuses what it cannot represent rather
    /// than guessing, and reports the cause as the second return value. Mission
    /// scripts branch on that `err`, so it must be a string and not nil.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn encode_indents_on_request_and_refuses_unrepresentable_values() {
        state()
            .load(
                r#"
                assert(json.encode({ n = 1 }) == '{"n":1}')
                assert(json.encode({ n = 1 }, { pretty = true }) == '{\n  "n": 1\n}')

                -- A function has no JSON form: (nil, err), never a raise.
                local out, err = json.encode({ f = print })
                assert(out == nil and type(err) == "string", tostring(err))

                -- NaN is not a failure here: serde renders it as null, the same
                -- coercion safe_encode makes explicit. Pinned so a codec swap
                -- can't start raising on the one value telemetry mods produce.
                assert(json.encode({ x = 0/0 }) == '{"x":null}')
                "#,
            )
            .exec()
            .expect("encode suite");
    }

    /// `safe_encode` is the codec every RPC result goes through: it coerces the
    /// sim-unsafe values `encode` refuses instead of failing, so one NaN in a
    /// telemetry table cannot blank a whole response.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn safe_encode_coerces_what_encode_refuses() {
        state()
            .load(
                r#"
                assert(json.safe_encode({ x = 0/0 }) == '{"x":null}')
                assert(json.safe_encode({ x = math.huge }) == '{"x":null}')
                assert(json.safe_encode("\255") == '"\239\191\189"', "lossy, not an error")

                -- Still refused: a function is not a value, coercion or not.
                local out, err = json.safe_encode(print)
                assert(out == nil and err:find("not JSON%-serializable"), tostring(err))
                "#,
            )
            .exec()
            .expect("safe_encode suite");
    }

    /// `decode` round-trips and reports a parse error as `(nil, err)` — the
    /// editor sends hand-written JSON over the bridge, and a malformed payload
    /// must not abort the handler that decoded it.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn decode_round_trips_and_reports_a_parse_error() {
        state()
            .load(
                r#"
                local t = assert(json.decode('{"a":[1,2],"b":"x","c":true}'))
                assert(t.a[1] == 1 and t.a[2] == 2 and t.b == "x" and t.c == true)

                local arr = assert(json.decode("[10,20,30]"))
                assert(#arr == 3 and arr[3] == 30, "arrays decode 1-based")

                local out, err = json.decode("{ not json")
                assert(out == nil and type(err) == "string", tostring(err))
                "#,
            )
            .exec()
            .expect("decode suite");
    }
}
