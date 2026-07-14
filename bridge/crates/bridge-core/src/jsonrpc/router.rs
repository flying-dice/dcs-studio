use log::debug;
use mlua::prelude::{LuaFunction, LuaTable};
use mlua::{Lua, LuaSerdeExt, UserData, UserDataMethods};
use serde::Deserialize;
use std::collections::HashMap;

/// Discover metadata a Lua registration may attach to a method:
/// `{ summary?, description?, params?, result? }`, feeding the `OpenRPC` document
/// `rpc.discover` returns. Everything is optional — a bare
/// `add_method(name, fn)` still catalogs the name.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct MethodMeta {
    /// A short one-line summary (`OpenRPC` `method.summary`).
    pub summary: Option<String>,
    /// A longer description (`OpenRPC` `method.description`).
    pub description: Option<String>,
    pub params: Option<Vec<ParamMeta>>,
    /// The result content descriptor (`OpenRPC` `method.result`).
    pub result: Option<ResultMeta>,
}

/// One parameter descriptor a Lua registration may attach — an entry of
/// `MethodMeta::params`, rendered into the `OpenRPC` method's parameter list.
#[derive(Debug, Clone, Deserialize)]
pub struct ParamMeta {
    /// The parameter name (`OpenRPC` `contentDescriptor.name`).
    pub name: String,
    /// The `EmmyLua`/JSON-schema type string (`OpenRPC` `schema`). Defaults to a
    /// permissive schema when absent.
    #[serde(rename = "type")]
    pub ty: Option<String>,
    /// Whether the parameter is required (`OpenRPC` `contentDescriptor.required`).
    pub required: Option<bool>,
    /// A human-readable description (`OpenRPC` `contentDescriptor.description`).
    pub description: Option<String>,
}

/// The result descriptor a Lua registration may attach — becomes the `OpenRPC`
/// `method.result` content descriptor. All fields optional; a missing result
/// degrades to a permissive `{ name = "result", schema = {} }`.
#[derive(Debug, Clone, Deserialize)]
pub struct ResultMeta {
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub ty: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug)]
struct MethodEntry {
    handler: LuaFunction,
    meta: MethodMeta,
}

/// A method-name → Lua-handler table for JSON-RPC dispatch, exposed to Lua as
/// the `JsonRpcRouter` userdata. Each entry pairs the handler with its
/// [`MethodMeta`], so the router doubles as the source the `OpenRPC` builder
/// walks for `rpc.discover`.
#[derive(Debug, Default)]
pub struct JsonRpcRouter {
    methods: HashMap<String, MethodEntry>,
}

impl JsonRpcRouter {
    fn new() -> Self {
        Self::default()
    }

    fn add_method(&mut self, name: String, callback: LuaFunction, meta: MethodMeta) {
        debug!("Adding method: {name:?}");
        self.methods.insert(
            name,
            MethodEntry {
                handler: callback,
                meta,
            },
        );
    }

    pub fn get_method(&self, name: &str) -> Option<&LuaFunction> {
        debug!("Getting method: {name:?}");
        self.methods.get(name).map(|entry| &entry.handler)
    }

    /// Every registered method, sorted by name, paired with its metadata — the
    /// single source the `OpenRPC` builder ([`crate::jsonrpc::openrpc`]) turns
    /// into the `rpc.discover` document.
    pub fn methods_sorted(&self) -> Vec<(&str, &MethodMeta)> {
        let mut entries: Vec<(&str, &MethodMeta)> = self
            .methods
            .iter()
            .map(|(name, entry)| (name.as_str(), &entry.meta))
            .collect();
        entries.sort_by(|a, b| a.0.cmp(b.0));
        entries
    }
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
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod tests {
    use super::*;

    // Pure-logic, but on Windows the test binary links DCS's lua.dll, so it is
    // gated like the rest (put a lua.dll on PATH and run with
    // `-- --include-ignored`). On non-Windows the build.rs links PUC liblua5.1
    // and it runs as an ordinary test.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn methods_sorted_returns_names_alphabetical_with_meta() {
        let lua = Lua::new();
        let noop = lua.create_function(|_, ()| Ok(())).expect("fn");
        let mut router = JsonRpcRouter::new();
        router.add_method("ping".into(), noop.clone(), MethodMeta::default());
        router.add_method(
            "eval".into(),
            noop,
            MethodMeta {
                summary: Some("Run Lua".into()),
                description: Some("Run Lua in this state.".into()),
                params: Some(vec![ParamMeta {
                    name: "code".into(),
                    ty: Some("string".into()),
                    required: Some(true),
                    description: None,
                }]),
                result: Some(ResultMeta {
                    name: Some("value".into()),
                    ty: None,
                    description: Some("The return value.".into()),
                }),
            },
        );

        let methods = router.methods_sorted();
        let names: Vec<&str> = methods.iter().map(|(n, _)| *n).collect();
        assert_eq!(
            names,
            vec!["eval", "ping"],
            "alphabetical, no synthetic entry"
        );

        let (_, eval) = &methods[0];
        assert_eq!(eval.summary.as_deref(), Some("Run Lua"));
        assert_eq!(eval.params.as_ref().expect("params")[0].name, "code");
        assert_eq!(
            eval.result.as_ref().and_then(|r| r.name.as_deref()),
            Some("value")
        );
        // A bare registration keeps default (empty) metadata.
        let (_, ping) = &methods[1];
        assert!(ping.description.is_none());
    }
}
