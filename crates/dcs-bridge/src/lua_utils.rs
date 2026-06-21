use log::{debug, warn};
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
pub fn opt_bool(opts: &Option<LuaTable>, key: &str) -> bool {
    opts.as_ref()
        .and_then(|t| t.get::<Option<bool>>(key).ok().flatten())
        .unwrap_or(false)
}

/// `opts.<key>` as a string, if present (shared opts reader).
pub fn opt_str(opts: &Option<LuaTable>, key: &str) -> Option<String> {
    opts.as_ref()
        .and_then(|t| t.get::<Option<String>>(key).ok().flatten())
}

/**
 * Check if a Lua table is an array by checking if it has contiguous integer keys starting from 1.
 */
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

pub fn serialize_lua_to_json(lua_value: &LuaValue) -> Option<Value> {
    debug!("Serializing Lua value: {:?}", lua_value);
    match lua_value {
        LuaValue::Nil => Some(Value::Null),
        LuaValue::Boolean(b) => Some(Value::Bool(*b)),
        LuaValue::Integer(i) => Some(Value::Number((*i).into())),
        // JSON has no NaN/Infinity, and `from_f64` returns None for them — a
        // Lua `0/0` or `math.huge` reaching here must NOT `unwrap`-panic and
        // crash the sim. Fall back to null.
        LuaValue::Number(n) => {
            Some(serde_json::Number::from_f64(*n).map_or(Value::Null, Value::Number))
        }
        // Lua strings are byte strings; a non-UTF-8 one must not panic the
        // serializer (and the sim). Decode lossily — invalid bytes become the
        // replacement char rather than aborting.
        LuaValue::String(s) => Some(Value::String(s.to_string_lossy())),
        LuaValue::Table(table) => match is_lua_array(table) {
            Ok(true) => serialize_lua_array_to_json(table),
            Ok(false) => serialize_lua_table_to_json(table),
            Err(_) => {
                warn!("Failed to determine if Lua table is an array");
                None
            }
        },
        other => Some(other.type_name().into()),
    }
}

fn serialize_lua_table_to_json(table: &LuaTable) -> Option<Value> {
    let mut map = serde_json::Map::new();
    for pair in table.pairs::<LuaValue, LuaValue>() {
        match pair {
            Ok((key, value)) => {
                if let Ok(key_str) = key.to_string() {
                    debug!("Serializing Lua table key: {:?}", key_str);
                    if let Some(value_json) = serialize_lua_to_json(&value) {
                        map.insert(key_str, value_json);
                    }
                }
            }
            Err(_) => return None,
        }
    }
    Some(Value::Object(map))
}

fn serialize_lua_array_to_json(table: &LuaTable) -> Option<Value> {
    debug!(
        "Serializing Lua array: {:?} with {:?} elements",
        table,
        table.len()
    );
    let mut vec = Vec::new();
    for pair in table.pairs::<LuaValue, LuaValue>() {
        match pair {
            Ok((_, value)) => {
                debug!("Serializing Lua array element: {:?}", value);
                vec.push(serialize_lua_to_json(&value)?);
            }
            Err(_) => {
                warn!("Failed to serialize Lua array element {:?}", pair);
            }
        }
    }
    Some(Value::Array(vec))
}
