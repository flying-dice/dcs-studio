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
        LuaValue::Table(table) => serialize_lua_table_to_json(table, depth),
        other => Err(format!(
            "value is not JSON-serializable: {}",
            other.type_name()
        )),
    }
}

/// A table becomes a JSON array or a JSON object, and only its keys decide
/// which — in **one** traversal.
///
/// The classification cannot be read off `raw_len` and a probe of the first
/// key: `#t` sees the array part only, so `{ 1, 2, a = 3 }` and `{ 1, 2 }`
/// are indistinguishable by length, and only `pairs` reveals a hash-part key.
/// Since the walk that answers the question is exactly the walk that reads the
/// values, the entries are buffered once and classified from the buffer —
/// rather than the previous shape, which traversed the whole table to classify
/// it (materialising every key *and* every value through mlua) and then threw
/// that away and traversed it again to encode.
///
/// Iterating as `LuaValue`/`LuaValue` makes both conversions the identity, so a
/// pair can never fail to materialise; taking the ones that do keeps the walk
/// total, the same way `globals::walk_table` stays total over a live `_G`.
fn serialize_lua_table_to_json(table: &LuaTable, depth: usize) -> Result<Value, String> {
    let entries: Vec<(LuaValue, LuaValue)> = table
        .pairs::<LuaValue, LuaValue>()
        .filter_map(std::result::Result::ok)
        .collect();

    if is_array(entries.iter().map(|(key, _)| key)) {
        let values = entries
            .iter()
            .map(|(_, value)| serialize_at(value, depth + 1))
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(Value::Array(values));
    }

    let mut map = serde_json::Map::with_capacity(entries.len());
    for (key, value) in &entries {
        // A key that can't be stringified names no JSON field — skip it rather
        // than fail the whole object (pre-Result behavior preserved).
        if let Some(key_str) = key_to_string(key) {
            map.insert(key_str, serialize_at(value, depth + 1)?);
        }
    }
    Ok(Value::Object(map))
}

/// Whether these keys, **in iteration order**, are a JSON array's: contiguous
/// integers from 1. Order-sensitive by design and unchanged from the predicate
/// this replaced — Lua walks the array part in order, so a real sequence always
/// classifies, while a table whose integer keys live in the hash part is
/// iterated in an order Lua does not define and is treated as an object.
fn is_array<'a>(keys: impl Iterator<Item = &'a LuaValue>) -> bool {
    let mut last_index = 0;
    for key in keys {
        match key {
            // Non-integer, non-positive, or non-contiguous: an object.
            LuaValue::Integer(i) if *i == last_index + 1 => last_index = *i,
            _ => return false,
        }
    }
    true
}

/// The JSON field name a Lua key becomes, or `None` when it names none.
///
/// The two key types that make up essentially all sim data are answered without
/// entering Lua at all. Only the rest reach [`LuaValue::to_string`], which
/// pushes the value and runs `__tostring` — a metamethod that can raise, which
/// is why the whole thing is fallible in the first place. Both fast paths
/// reproduce `to_string`'s answer exactly, including that a non-UTF-8 byte
/// string is *not* a field name (it is dropped, not lossily decoded — unlike a
/// string *value*, which coerces).
fn key_to_string(key: &LuaValue) -> Option<String> {
    match key {
        LuaValue::Integer(i) => Some(i.to_string()),
        LuaValue::String(s) => s.to_str().ok().map(|s| s.to_string()),
        other => other.to_string().ok(),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod tests {
    use super::{serialize_lua_to_json, to_json_string, to_safe_json_string};
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
    ///
    /// Asserted through the serializer rather than a private predicate: the
    /// shape the editor receives *is* the classification, so this pins the
    /// observable and stays true however the walk is arranged internally.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn array_detection_requires_contiguous_one_based_keys() {
        let lua = Lua::new();
        let shape = |chunk: &str| {
            serialize_lua_to_json(&eval(&lua, chunk))
                .expect("serialize")
                .is_array()
        };

        assert!(shape("return {}"), "empty is a (degenerate) array");
        assert!(shape("return {10, 20, 30}"), "dense array");
        assert!(!shape("return { a = 1 }"), "string keys only");
        assert!(!shape("return { [0] = 1 }"), "0-based");
        assert!(!shape("return { [1] = 1, [3] = 3 }"), "hole at 2");
        assert!(
            !shape("return { [2] = 1, [5] = 2 }"),
            "numeric, non-contiguous"
        );
        assert!(
            !shape("return { 1, 2, a = 3 }"),
            "mixed integer and string keys"
        );
        assert!(!shape("return { [1.5] = 1 }"), "fractional key");
    }

    /// The exact JSON each of those shapes produces — not just array-vs-object
    /// but the field names a non-array table's integer keys become. A table
    /// with a hole is an object keyed `"1"`/`"3"`, and the editor's decoders
    /// are written against that; a "smarter" classifier that filled the hole
    /// with null, or renumbered, would break them silently.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn the_classified_shapes_render_exactly_these_documents() {
        let lua = Lua::new();
        let json = |chunk: &str| {
            serialize_lua_to_json(&eval(&lua, chunk))
                .expect("serialize")
                .to_string()
        };

        assert_eq!(json("return {}"), "[]");
        assert_eq!(json("return {10, 20, 30}"), "[10,20,30]");
        assert_eq!(json("return { a = 1 }"), r#"{"a":1}"#);
        assert_eq!(json("return { [0] = 1 }"), r#"{"0":1}"#);
        assert_eq!(json("return { [1] = 1, [3] = 3 }"), r#"{"1":1,"3":3}"#);
        assert_eq!(json("return { [2] = 1, [5] = 2 }"), r#"{"2":1,"5":2}"#);
        assert_eq!(json("return { 1, 2, a = 3 }"), r#"{"1":1,"2":2,"a":3}"#);
        assert_eq!(json("return { [1.5] = 1 }"), r#"{"1.5":1}"#);
    }

    /// Key stringification is Lua's, not Rust's, and the difference is visible:
    /// a float key renders through Lua's `%.14g` (`1.5`, and `2.0` as the
    /// integer `2` because mlua hands whole numbers back as integers), while a
    /// non-UTF-8 byte string names no field at all and is dropped. Both are
    /// load-bearing — a fast path for the common String/Integer keys must not
    /// change either answer.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn key_stringification_is_pinned_for_every_key_type() {
        let lua = Lua::new();
        let json = |chunk: &str| {
            serialize_lua_to_json(&eval(&lua, chunk))
                .expect("serialize")
                .to_string()
        };

        assert_eq!(json("return { [2.0] = 'x', z = 1 }"), r#"{"2":"x","z":1}"#);
        assert_eq!(json("return { [-1] = 'x' }"), r#"{"-1":"x"}"#);
        assert_eq!(json("return { [true] = 'x' }"), r#"{"true":"x"}"#);
        // A non-UTF-8 key cannot name a JSON field: dropped, siblings survive.
        assert_eq!(json(r"return { ['\255'] = 1, ok = 2 }"), r#"{"ok":2}"#);
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

        // Buried in a container it is the same answer, from either shape: the
        // element/field is what has no JSON form, and the walk reports that
        // instead of silently dropping it or encoding a placeholder. A DCS
        // table full of API functions reaches this on both paths — `db.Weapons`
        // (keyed) and a pylon's `Launchers` (an array).
        let in_array = serialize_lua_to_json(&eval(&lua, "return { 1, 2, print }"))
            .expect_err("an array element with no JSON form");
        assert!(in_array.contains("function"), "{in_array}");
        let in_object = serialize_lua_to_json(&eval(&lua, "return { fn = print }"))
            .expect_err("a field with no JSON form");
        assert!(in_object.contains("function"), "{in_object}");
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
