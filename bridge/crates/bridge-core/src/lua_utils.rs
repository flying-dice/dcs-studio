use log::debug;
use mlua::prelude::{LuaTable, LuaValue};
use serde_json::Value;

/// Serialize any `Serialize` value to a JSON string, pretty or compact — the one
/// place the pretty/compact fork lives (shared by `json` and `file`).
pub fn to_json_string<T: serde::Serialize>(value: &T, pretty: bool) -> serde_json::Result<String> {
    if pretty {
        serde_json::to_string_pretty(value)
    } else {
        serde_json::to_string(value)
    }
}

/// Sim-safe JSON text for a Lua value: coerce it first (NaN/Inf → null,
/// non-UTF-8 lossy) via [`serialize_lua_to_json`], then render.
///
/// The render step is deliberately `Display` rather than
/// `serde_json::to_string`: a `serde_json::Value` is already a valid document,
/// so writing it out cannot fail, and `{:#}` is exactly `to_string_pretty`.
/// That leaves *one* failure mode — a Lua value with no JSON form at all —
/// instead of a second, unreachable serializer error every caller has to
/// pretend to handle.
///
/// # Errors
///
/// Returns [`serialize_lua_to_json`]'s cause when the value cannot be
/// represented as JSON (a cycle past the depth cap, a function, …).
pub fn to_safe_json_string(value: &LuaValue, pretty: bool) -> Result<String, String> {
    let json = serialize_lua_to_json(value)?;
    Ok(if pretty {
        format!("{json:#}")
    } else {
        json.to_string()
    })
}

/// `opts.<key>` as a bool, defaulting to false (shared opts reader).
pub fn opt_bool(opts: Option<&LuaTable>, key: &str) -> bool {
    opts.and_then(|t| t.get::<Option<bool>>(key).ok().flatten())
        .unwrap_or(false)
}

/// `opts.<key>` as a string, if present (shared opts reader).
pub fn opt_str(opts: Option<&LuaTable>, key: &str) -> Option<String> {
    opts.and_then(|t| t.get::<Option<String>>(key).ok().flatten())
}

/// Whether a Lua table is an array: contiguous integer keys starting from 1.
///
/// Total by construction — iterating as `LuaValue`/`LuaValue` makes both
/// conversions the identity, so there is no read failure to report and callers
/// get a plain answer rather than a `Result` with an unreachable error arm.
pub fn is_lua_array(table: &LuaTable) -> bool {
    let mut last_index = 0;

    for (key, _) in table
        .pairs::<LuaValue, LuaValue>()
        .filter_map(std::result::Result::ok)
    {
        let index = match key {
            LuaValue::Integer(i) if i > 0 => i,
            _ => return false, // Non-integer or non-positive index
        };

        if index != last_index + 1 {
            return false; // Not contiguous
        }

        last_index = index;
    }

    true
}

/// How deep [`serialize_lua_to_json`] recurses into nested Lua tables before
/// refusing. A self-referential table (`t.self = t`, reachable from
/// `json.safe_encode`, `file.write_json`/`dump`, `toml.encode`, or any RPC
/// handler result) would otherwise recurse until the stack overflows and aborts
/// the sim. Mirrors the cap in `globals.rs`; 64 is far past any real sim-data
/// nesting, so the bound only ever trips on a cycle or pathological input.
const MAX_JSON_DEPTH: usize = 64;

/// Serialize a Lua value to a `serde_json::Value`, coercing sim-unsafe scalars
/// (NaN/Inf → null, non-UTF-8 strings lossily) rather than failing, and bounding
/// recursion so a cyclic table can never overflow the stack — the guarantee
/// that keeps `json.safe_encode`'s documented "never panics" contract true.
///
/// # Errors
///
/// Returns a human-readable cause when the value can't be represented as JSON:
/// the depth cap was reached (a cycle or pathologically deep table), or the
/// value is a type with no JSON form (function, thread, userdata, …).
pub fn serialize_lua_to_json(lua_value: &LuaValue) -> Result<Value, String> {
    serialize_at(lua_value, 0)
}

/// [`serialize_lua_to_json`] with the current recursion `depth`, checked against
/// [`MAX_JSON_DEPTH`] before recursing into any child.
fn serialize_at(lua_value: &LuaValue, depth: usize) -> Result<Value, String> {
    if depth >= MAX_JSON_DEPTH {
        return Err(format!("depth limit exceeded at depth {depth}"));
    }
    debug!("Serializing Lua value: {lua_value:?}");
    match lua_value {
        LuaValue::Nil => Ok(Value::Null),
        LuaValue::Boolean(b) => Ok(Value::Bool(*b)),
        LuaValue::Integer(i) => Ok(Value::Number((*i).into())),
        // JSON has no NaN/Infinity, and `from_f64` returns None for them — a
        // Lua `0/0` or `math.huge` reaching here must NOT `unwrap`-panic and
        // crash the sim. Fall back to null.
        LuaValue::Number(n) => {
            Ok(serde_json::Number::from_f64(*n).map_or(Value::Null, Value::Number))
        }
        // Lua strings are byte strings; a non-UTF-8 one must not panic the
        // serializer (and the sim). Decode lossily — invalid bytes become the
        // replacement char rather than aborting.
        LuaValue::String(s) => Ok(Value::String(s.to_string_lossy())),
        LuaValue::Table(table) => {
            if is_lua_array(table) {
                serialize_lua_array_to_json(table, depth)
            } else {
                serialize_lua_table_to_json(table, depth)
            }
        }
        other => Err(format!(
            "value is not JSON-serializable: {}",
            other.type_name()
        )),
    }
}

fn serialize_lua_table_to_json(table: &LuaTable, depth: usize) -> Result<Value, String> {
    let mut map = serde_json::Map::new();
    // Iterating as `LuaValue` makes both conversions the identity, so a pair
    // can never fail to materialise; taking the ones that do keeps the walk
    // total, the same way `globals::walk_table` stays total over a live `_G`.
    for (key, value) in table
        .pairs::<LuaValue, LuaValue>()
        .filter_map(std::result::Result::ok)
    {
        // A key that can't be stringified names no JSON field — skip it rather
        // than fail the whole object (pre-Result behavior preserved).
        if let Ok(key_str) = key.to_string() {
            debug!("Serializing Lua table key: {key_str:?}");
            map.insert(key_str, serialize_at(&value, depth + 1)?);
        }
    }
    Ok(Value::Object(map))
}

fn serialize_lua_array_to_json(table: &LuaTable, depth: usize) -> Result<Value, String> {
    debug!(
        "Serializing Lua array: {:?} with {:?} elements",
        table,
        table.len()
    );
    let mut vec = Vec::new();
    // See `serialize_lua_table_to_json`: a `LuaValue`/`LuaValue` pair cannot
    // fail to materialise, so there is no error arm to handle here.
    for (_, value) in table
        .pairs::<LuaValue, LuaValue>()
        .filter_map(std::result::Result::ok)
    {
        debug!("Serializing Lua array element: {value:?}");
        vec.push(serialize_at(&value, depth + 1)?);
    }
    Ok(Value::Array(vec))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod tests {
    use super::{is_lua_array, serialize_lua_to_json, to_json_string, to_safe_json_string};
    use mlua::prelude::{LuaTable, LuaValue};
    use mlua::Lua;

    fn eval(lua: &Lua, chunk: &str) -> LuaValue {
        lua.load(chunk).eval().expect("eval")
    }

    fn eval_table(lua: &Lua, chunk: &str) -> LuaTable {
        lua.load(chunk).eval().expect("eval table")
    }

    /// A Lua table is an array only with contiguous 1-based integer keys —
    /// everything else is an object. Sim data is full of both shapes (a group's
    /// `units` list vs. a unit's keyed record), and misclassifying one emits
    /// `{"1":...}` where the editor expects `[...]`.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn array_detection_requires_contiguous_one_based_keys() {
        let lua = Lua::new();
        let is_array = |chunk: &str| is_lua_array(&eval_table(&lua, chunk));

        assert!(is_array("return {}"), "empty is a (degenerate) array");
        assert!(is_array("return {10, 20, 30}"));
        assert!(!is_array("return { a = 1 }"), "string key");
        assert!(!is_array("return { [0] = 1 }"), "0-based");
        assert!(!is_array("return { [1] = 1, [3] = 3 }"), "hole at 2");
        assert!(!is_array("return { [1.5] = 1 }"), "fractional key");
    }

    /// The sim-unsafe scalars a mission can hand us — `0/0`, `math.huge`, a
    /// byte string that is not UTF-8 — must coerce, not fail. `json.safe_encode`
    /// documents "never panics", and every RPC result the editor sees goes
    /// through here.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn unsafe_scalars_coerce_instead_of_failing() {
        let lua = Lua::new();
        let json = |chunk: &str| serialize_lua_to_json(&eval(&lua, chunk)).expect("serialize");

        assert_eq!(json("return nil").to_string(), "null");
        assert_eq!(json("return true").to_string(), "true");
        assert_eq!(json("return 7").to_string(), "7");
        assert_eq!(json("return 1.5").to_string(), "1.5");
        assert_eq!(json("return 'hi'").to_string(), "\"hi\"");
        // JSON has no NaN/Infinity and `Number::from_f64` yields None for both.
        assert_eq!(json("return 0/0").to_string(), "null");
        assert_eq!(json("return math.huge").to_string(), "null");
        assert_eq!(json("return -math.huge").to_string(), "null");
        // Lua strings are byte strings; DCS ships plenty of Latin-1 unit names.
        assert_eq!(
            json(r"return '\255\254'").to_string(),
            "\"\u{fffd}\u{fffd}\""
        );
    }

    /// A value with no JSON form at all is refused with its Lua type named, so
    /// the editor's error says "function" rather than an empty result the
    /// caller has to guess about.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_value_with_no_json_form_is_named_in_the_error() {
        let lua = Lua::new();
        let err = serialize_lua_to_json(&eval(&lua, "return print")).expect_err("no JSON form");
        assert!(err.contains("not JSON-serializable"), "{err}");
        assert!(err.contains("function"), "{err}");
    }

    /// A self-referential table would recurse until the stack overflows, and a
    /// stack overflow inside the DLL aborts DCS. The depth cap turns it into an
    /// ordinary error — this is the guarantee behind `safe_encode`'s "never
    /// panics", reachable from every RPC result and every `file.dump`.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_cyclic_table_hits_the_depth_cap_instead_of_the_stack_guard() {
        let lua = Lua::new();
        let cyclic = eval(&lua, "local t = {}; t.self = t; return t");
        let err = serialize_lua_to_json(&cyclic).expect_err("cycle must be refused");
        assert!(err.contains("depth limit exceeded"), "{err}");

        // Nesting under the cap still encodes — the bound must not reject real
        // sim data, which never nests anywhere near 64 deep.
        let deep = eval(
            &lua,
            "local t = {}; local c = t; for _ = 1, 40 do c.n = {}; c = c.n end; return t",
        );
        serialize_lua_to_json(&deep).expect("40 deep is well inside the cap");
    }

    /// Nested containers keep their shape through the walk: arrays stay arrays
    /// at every depth, keyed tables stay objects, and the two nest freely —
    /// the shape the editor's `unpack` of an RPC result depends on.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn nested_arrays_and_objects_keep_their_shape() {
        let lua = Lua::new();
        let value = serialize_lua_to_json(&eval(
            &lua,
            "return { units = { { name = 'F-15C' }, { name = 'Su-27' } }, n = 2 }",
        ))
        .expect("serialize");
        assert_eq!(
            value.to_string(),
            r#"{"n":2,"units":[{"name":"F-15C"},{"name":"Su-27"}]}"#
        );
    }

    /// The pretty fork is the only difference between the two renderers, and
    /// `file.write_json`'s `opts.pretty` rides on it. `Display`-with-`{:#}` must
    /// stay byte-identical to `serde_json::to_string_pretty`, or a checked-in
    /// dump would churn the moment the implementation changed.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn the_pretty_fork_matches_serde_json_exactly() {
        let lua = Lua::new();
        let value = eval(&lua, "return { a = 1, b = { 2, 3 } }");

        let coerced = serialize_lua_to_json(&value).expect("coerce");
        assert_eq!(
            to_safe_json_string(&value, true).expect("pretty"),
            to_json_string(&coerced, true).expect("serde pretty")
        );
        assert_eq!(
            to_safe_json_string(&value, false).expect("compact"),
            to_json_string(&coerced, false).expect("serde compact")
        );
    }

    /// A key that cannot be stringified names no JSON field, so it is dropped
    /// and its siblings still encode. A mission's table can carry a table key
    /// with a raising `__tostring` (DCS's own object wrappers do), and losing
    /// the whole RPC result over one unnameable key would be far worse than
    /// losing the key.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_key_that_cannot_be_stringified_is_dropped_not_fatal() {
        let lua = Lua::new();
        let table = eval_table(
            &lua,
            r#"
            local hostile = setmetatable({}, { __tostring = function() error("no name") end })
            local t = { keep = 1 }
            t[hostile] = "lost"
            return t
            "#,
        );
        let value = serialize_lua_to_json(&LuaValue::Table(table)).expect("must not fail");
        assert_eq!(
            value.to_string(),
            r#"{"keep":1}"#,
            "the unnameable key is dropped, its siblings survive"
        );
    }

    /// `to_json_string` serializes a Lua value *directly*, without the coercion
    /// pass — so it is the one that genuinely fails on an unrepresentable
    /// value. `json.encode` exposes that as `(nil, err)`; `json.safe_encode`
    /// goes through the coercing path instead.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn the_direct_serializer_reports_values_it_cannot_represent() {
        let lua = Lua::new();
        let table = eval_table(&lua, "return { f = print }");
        to_json_string(&LuaValue::Table(table), false).expect_err("a function has no JSON form");
    }
}
