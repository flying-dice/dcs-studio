use log::LevelFilter;
use mlua::{FromLua, Lua, LuaSerdeExt, Value as LuaValue};
use serde::Deserialize;

/// Optional module configuration read from the Lua global `DCS_STUDIO`,
/// e.g. `DCS_STUDIO = { logger_level = "info" }`.
#[derive(Debug, Clone, Deserialize)]
pub struct ModuleConfig {
    pub logger_level: Option<LevelFilter>,
}

impl Default for ModuleConfig {
    fn default() -> Self {
        Self {
            logger_level: Some(LevelFilter::Trace),
        }
    }
}

impl FromLua for ModuleConfig {
    fn from_lua(value: LuaValue, lua: &Lua) -> mlua::Result<Self> {
        lua.from_value(value)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod tests {
    use super::{LevelFilter, ModuleConfig};
    use mlua::Lua;

    /// `DCS_STUDIO = { logger_level = "warn" }` — set by the `GameGUI` hook
    /// before `require` — is the only knob on how much the bridge writes to its
    /// (non-rolling) log file, so the level really has to arrive from the Lua
    /// table. Anything the table cannot supply falls back to the default, which
    /// is what `bootstrap` does with a state that never set the global at all.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn the_level_is_read_from_the_lua_table_and_falls_back_when_it_cannot_be() {
        let lua = Lua::new();
        let read = |source: &str| -> mlua::Result<ModuleConfig> {
            lua.load(source).exec().expect("set DCS_STUDIO");
            lua.globals().get::<ModuleConfig>("DCS_STUDIO")
        };

        assert_eq!(
            read(r#"DCS_STUDIO = { logger_level = "warn" }"#)
                .expect("config")
                .logger_level,
            Some(LevelFilter::Warn)
        );
        assert_eq!(
            read("DCS_STUDIO = {}").expect("config").logger_level,
            None,
            "an omitted level is not an error; bootstrap picks the default"
        );
        assert!(
            read(r#"DCS_STUDIO = { logger_level = "chatty" }"#).is_err(),
            "an unknown level is refused rather than silently ignored"
        );
        assert!(
            read("DCS_STUDIO = nil").is_err(),
            "no config table at all is refused, and bootstrap defaults"
        );
        assert_eq!(
            ModuleConfig::default().logger_level,
            Some(LevelFilter::Trace)
        );
    }
}
