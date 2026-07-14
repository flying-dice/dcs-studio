use log::debug;
use mlua::prelude::{LuaFunction, LuaTable};
use mlua::{Lua, LuaSerdeExt, UserData, UserDataMethods};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;

/// Discover metadata a Lua registration may attach to a method:
/// `{ description = string, params = { { name, type, required?, description? }, ... } }`.
/// Everything is optional — a bare `add_method(name, fn)` still catalogs the name.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct MethodMeta {
    pub description: Option<String>,
    pub params: Option<Vec<ParamMeta>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ParamMeta {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: Option<String>,
    pub required: Option<bool>,
    pub description: Option<String>,
}

#[derive(Debug)]
struct MethodEntry {
    handler: LuaFunction,
    meta: MethodMeta,
}

#[derive(Debug, Default)]
pub struct JsonRpcRouter {
    methods: HashMap<String, MethodEntry>,
}

impl JsonRpcRouter {
    fn new() -> Self {
        Self::default()
    }

    fn add_method(&mut self, name: String, callback: LuaFunction, meta: MethodMeta) {
        debug!("Adding method: {:?}", name);
        self.methods.insert(
            name,
            MethodEntry {
                handler: callback,
                meta,
            },
        );
    }

    pub fn get_method(&self, name: &str) -> Option<&LuaFunction> {
        debug!("Getting method: {:?}", name);
        self.methods.get(name).map(|entry| &entry.handler)
    }

    /// The machine-readable method catalog for `rpc.discover`: every
    /// registered method (sorted by name, with whatever metadata the
    /// registration attached) plus a synthetic `rpc.discover` entry.
    pub fn catalog(&self) -> Value {
        let mut names: Vec<&String> = self.methods.keys().collect();
        names.sort();
        let mut methods: Vec<Value> = names
            .into_iter()
            .map(|name| {
                let meta = &self.methods[name].meta;
                method_entry_json(name, meta)
            })
            .collect();
        methods.push(json!({
            "name": "rpc.discover",
            "description": "This catalog: every JSON-RPC method this bridge serves, with descriptions and parameters.",
        }));
        methods.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        Value::Array(methods)
    }
}

fn method_entry_json(name: &str, meta: &MethodMeta) -> Value {
    let mut entry = json!({ "name": name });
    if let Some(description) = &meta.description {
        entry["description"] = json!(description);
    }
    if let Some(params) = &meta.params {
        entry["params"] = Value::Array(
            params
                .iter()
                .map(|p| {
                    let mut param = json!({ "name": p.name });
                    if let Some(ty) = &p.ty {
                        param["type"] = json!(ty);
                    }
                    if let Some(required) = p.required {
                        param["required"] = json!(required);
                    }
                    if let Some(description) = &p.description {
                        param["description"] = json!(description);
                    }
                    param
                })
                .collect(),
        );
    }
    entry
}

impl UserData for JsonRpcRouter {
    fn add_methods<'lua, M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_function("new", |_lua: &Lua, (): ()| Ok(JsonRpcRouter::new()));

        methods.add_meta_method(mlua::MetaMethod::ToString, |_, this: &Self, ()| {
            Ok(format!("JsonRpcRouter({:?})", this.methods))
        });

        methods.add_method_mut(
            "add_method",
            |lua: &Lua,
             this: &mut JsonRpcRouter,
             (name, callback, meta): (String, LuaFunction, Option<LuaTable>)| {
                // Malformed metadata degrades to a bare catalog entry rather
                // than failing the registration — discover data is advisory.
                let meta = meta
                    .and_then(|t| lua.from_value::<MethodMeta>(mlua::Value::Table(t)).ok())
                    .unwrap_or_default();
                this.add_method(name, callback, meta);
                Ok(())
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pure-logic, but on Windows the test binary links DCS's lua.dll, so it is
    // gated like the rest (put a lua.dll on PATH and run with
    // `-- --include-ignored`). On non-Windows the build.rs links PUC liblua5.1
    // and it runs as an ordinary test.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn catalog_lists_methods_sorted_with_meta_and_discover() {
        let lua = Lua::new();
        let noop = lua.create_function(|_, ()| Ok(())).expect("fn");
        let mut router = JsonRpcRouter::new();
        router.add_method("ping".into(), noop.clone(), MethodMeta::default());
        router.add_method(
            "eval".into(),
            noop,
            MethodMeta {
                description: Some("Run Lua".into()),
                params: Some(vec![ParamMeta {
                    name: "code".into(),
                    ty: Some("string".into()),
                    required: Some(true),
                    description: None,
                }]),
            },
        );

        let catalog = router.catalog();
        let names: Vec<&str> = catalog
            .as_array()
            .expect("array")
            .iter()
            .map(|m| m["name"].as_str().expect("name"))
            .collect();
        assert_eq!(
            names,
            vec!["eval", "ping", "rpc.discover"],
            "sorted + synthetic discover"
        );

        let eval = &catalog[0];
        assert_eq!(eval["description"], "Run Lua");
        assert_eq!(eval["params"][0]["name"], "code");
        assert_eq!(eval["params"][0]["type"], "string");
        assert_eq!(eval["params"][0]["required"], true);
        // A bare registration catalogs just the name.
        let ping = &catalog[1];
        assert_eq!(ping["name"], "ping");
        assert!(ping.get("description").is_none());
    }
}
