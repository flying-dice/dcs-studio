use log::LevelFilter;
use mlua::{FromLua, Lua, LuaSerdeExt, Value as LuaValue};
use serde::Deserialize;

/// Optional module configuration read from the Lua global `DCS_STUDIO`,
/// e.g. `DCS_STUDIO = { logger_level = "info" }`.
#[derive(Debug, Clone, Deserialize)]
pub struct ModuleConfig {
    pub logger_level: Option<LevelFilter>,
}

/// The level the bridge logs at when the Lua side supplies none — either
/// because `DCS_STUDIO` is absent/unreadable, or because the table omits
/// `logger_level`.
///
/// `Warn`, not `Trace`: this default is what actually ships. In a live DCS
/// session the hook's `DCS_STUDIO` assignment did not reach the `_G` this
/// module reads (DCS runs `Scripts/Hooks` chunks in their own environment
/// table), so the old `Trace` default took over and wrote 2.99 MB / 25,969
/// lines in ~25 minutes into a non-rolling file, synchronously on the sim
/// thread. A missing config must cost the user diagnostics, not frame time.
const DEFAULT_LEVEL: LevelFilter = LevelFilter::Warn;

impl Default for ModuleConfig {
    fn default() -> Self {
        Self {
            logger_level: Some(DEFAULT_LEVEL),
        }
    }
}

impl FromLua for ModuleConfig {
    fn from_lua(value: LuaValue, lua: &Lua) -> mlua::Result<Self> {
        lua.from_value(value)
    }
}

/// The level to log at in `lua`'s state: `DCS_STUDIO.logger_level` when the
/// global is there and carries one, [`DEFAULT_LEVEL`] otherwise.
///
/// Every failure mode collapses to the same safe default on purpose — an
/// absent global, a non-table value, and an unparseable level are all "the
/// Lua side did not tell us", and `bootstrap` runs inside `luaopen` where the
/// only place to report a bad config is the log this call is configuring.
pub(crate) fn logger_level(lua: &Lua) -> LevelFilter {
    lua.globals()
        .get::<ModuleConfig>("DCS_STUDIO")
        .unwrap_or_default()
        .logger_level
        .unwrap_or(DEFAULT_LEVEL)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod tests {
    use super::{logger_level, LevelFilter, ModuleConfig};
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
            Some(LevelFilter::Warn)
        );
    }

    /// The case CI never had (card 16, issue #65): a state where the config
    /// global was never set at all. Live, that is the normal case for the GUI
    /// bridge — DCS runs `Scripts/Hooks` chunks in their own environment, so
    /// the hook's assignment did not reach `_G` — and the old `Trace` default
    /// turned it into 2.99 MB of log on the sim thread in 25 minutes.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn an_absent_config_global_logs_at_warn_rather_than_trace() {
        let lua = Lua::new();
        assert_eq!(logger_level(&lua), LevelFilter::Warn);
    }

    /// The default must not swallow a level the Lua side did supply — the whole
    /// point of the global is that a user chasing a bug can turn it up.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_configured_level_still_wins_over_the_default() {
        let lua = Lua::new();
        lua.load(r#"DCS_STUDIO = { logger_level = "trace" }"#)
            .exec()
            .expect("set DCS_STUDIO");
        assert_eq!(logger_level(&lua), LevelFilter::Trace);
    }

    /// Every other way the config can fail to say anything usable collapses to
    /// the same safe default: `bootstrap` is configuring the only log there is,
    /// so there is nowhere to complain to.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn an_unusable_config_falls_back_to_warn_too() {
        let lua = Lua::new();
        for source in [
            "DCS_STUDIO = {}",
            r#"DCS_STUDIO = { logger_level = "chatty" }"#,
            r#"DCS_STUDIO = "warn""#,
        ] {
            lua.load(source).exec().expect("set DCS_STUDIO");
            assert_eq!(logger_level(&lua), LevelFilter::Warn, "{source}");
        }
    }
}
