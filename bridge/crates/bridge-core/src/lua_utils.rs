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

/// `opts.<key>` as a bool, defaulting to false (shared opts reader).
pub fn opt_bool(opts: Option<&LuaTable>, key: &str) -> bool {
    opts.and_then(|t| t.get::<Option<bool>>(key).ok().flatten())
        .unwrap_or(false)
}

/// `opts.<key>` as a string, if present (shared opts reader).
pub fn opt_str(opts: Option<&LuaTable>, key: &str) -> Option<String> {
    opts.and_then(|t| t.get::<Option<String>>(key).ok().flatten())
}

/// Check if a Lua table is an array by checking if it has contiguous integer
/// keys starting from 1.
///
/// # Errors
///
/// Returns any `mlua` error raised while iterating the table's pairs.
pub fn is_lua_array(table: &LuaTable) -> mlua::Result<bool> {
    let mut last_index = 0;

    for pair in table.pairs::<LuaValue, LuaValue>() {
        let (key, _) = pair?;

        let index = match key {
            LuaValue::Integer(i) if i > 0 => i,
            _ => return Ok(false), // Non-integer or non-positive index
        };

        if index != last_index + 1 {
            return Ok(false); // Not contiguous
        }

        last_index = index;
    }

    Ok(true)
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
/// the depth cap was reached (a cycle or pathologically deep table), a table
/// pair failed to read, or the value is a type with no JSON form (function,
/// thread, userdata, …).
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
        LuaValue::Table(table) => match is_lua_array(table) {
            Ok(true) => serialize_lua_array_to_json(table, depth),
            Ok(false) => serialize_lua_table_to_json(table, depth),
            Err(e) => Err(format!("table read error: {e}")),
        },
        other => Err(format!(
            "value is not JSON-serializable: {}",
            other.type_name()
        )),
    }
}

fn serialize_lua_table_to_json(table: &LuaTable, depth: usize) -> Result<Value, String> {
    let mut map = serde_json::Map::new();
    for pair in table.pairs::<LuaValue, LuaValue>() {
        let (key, value) = pair.map_err(|e| format!("table read error: {e}"))?;
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
    for pair in table.pairs::<LuaValue, LuaValue>() {
        let (_, value) = pair.map_err(|e| format!("table read error: {e}"))?;
        debug!("Serializing Lua array element: {value:?}");
        vec.push(serialize_at(&value, depth + 1)?);
    }
    Ok(Value::Array(vec))
}
