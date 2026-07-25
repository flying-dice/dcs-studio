use crate::facade::{p, p_opt, r, Sub};
use log::{debug, error, info, warn};
use mlua::prelude::LuaMetaMethod;
use mlua::{Lua, Result, UserData, UserDataMethods};

/// The Lua `logger.Logger` userdata: a namespaced logger constructed with
/// `logger.Logger.new(ns)` and registered under the string key "Logger" by
/// [`inject_module`]. (The type is live — reached only through the Lua proxy.)
struct Logger {
    ns: String,
}

impl Logger {
    pub fn new(ns: String) -> Self {
        Logger { ns }
    }

    pub fn debug(&self, msg: &str) {
        debug!(target: &self.ns, "{msg}");
    }

    pub fn info(&self, msg: &str) {
        info!(target: &self.ns, "{msg}");
    }

    pub fn warn(&self, msg: &str) {
        warn!(target: &self.ns, "{msg}");
    }

    pub fn error(&self, msg: &str) {
        error!(target: &self.ns, "{msg}");
    }
}

impl UserData for Logger {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_function("new", |_lua: &Lua, ns: String| Ok(Logger::new(ns)));

        methods.add_meta_method(LuaMetaMethod::ToString, |_: &Lua, this, (): ()| {
            Ok(format!("Logger({})", this.ns))
        });

        methods.add_method("debug", |_lua, this, msg: String| {
            this.debug(&msg);
            Ok(())
        });

        methods.add_method("info", |_lua, this, msg: String| {
            this.info(&msg);
            Ok(())
        });

        methods.add_method("warn", |_lua, this, msg: String| {
            this.warn(&msg);
            Ok(())
        });

        methods.add_method("error", |_lua, this, msg: String| {
            this.error(&msg);
            Ok(())
        });
    }
}

/// Register the `logger` sub-namespace: the level free functions and the
/// `Logger` userdata proxy, with their `.d.lua` types recorded.
pub fn register(sub: &mut Sub) -> Result<()> {
    let levels: [(&str, &str, log::Level); 4] = [
        ("debug", "Log a message at debug level.", log::Level::Debug),
        ("info", "Log a message at info level.", log::Level::Info),
        ("warn", "Log a message at warn level.", log::Level::Warn),
        ("error", "Log a message at error level.", log::Level::Error),
    ];
    for (name, doc, level) in levels {
        sub.func(
            name,
            &[p("msg", "string"), p_opt("ns", "string")],
            &[],
            doc,
            move |_lua: &Lua, (msg, ns): (String, Option<String>)| {
                log_at(level, &msg, ns.as_deref());
                Ok(())
            },
        )?;
    }

    let logger_ty = sub.qualified("Logger");
    sub.proxy::<Logger>(
        "Logger",
        "A namespaced logger writing to the DCS Studio log.",
        |ud| {
            ud.constructor(
                "new",
                &[p("ns", "string")],
                &[r(&logger_ty)],
                "Create a logger that tags every line with namespace `ns`.",
            )
            .method(
                "debug",
                &[p("msg", "string")],
                &[],
                "Log at debug level under this logger's namespace.",
            )
            .method(
                "info",
                &[p("msg", "string")],
                &[],
                "Log at info level under this logger's namespace.",
            )
            .method(
                "warn",
                &[p("msg", "string")],
                &[],
                "Log at warn level under this logger's namespace.",
            )
            .method(
                "error",
                &[p("msg", "string")],
                &[],
                "Log at error level under this logger's namespace.",
            );
        },
    )?;

    Ok(())
}

/// Log `msg` at `level`, to the namespaced `target` when `ns` is given. One body
/// for all four level free functions.
fn log_at(level: log::Level, msg: &str, ns: Option<&str>) {
    match ns {
        Some(namespace) => log::log!(target: namespace, level, "{msg}"),
        None => log::log!(level, "{msg}"),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod tests {
    use crate::facade::sub_table;
    use mlua::Lua;

    /// Drive the whole `logger` surface from Lua exactly as sim-side script
    /// does. Nothing here asserts on log output — the sink is the process-wide
    /// log4rs instance another test may own — the contract under test is that
    /// none of these calls can raise. They run on the sim's main loop from
    /// arbitrary mission code, so a raise (a bad namespace, a missing method)
    /// would surface as a scripting error mid-mission.
    ///
    /// Windows-ignored like the rest of the crate's mlua tests: there it needs
    /// DCS's `lua.dll` on the runtime path; on non-Windows the build.rs links
    /// PUC liblua5.1 so Linux CI runs it as an ordinary test (issue #28).
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn every_level_logs_with_and_without_a_namespace() {
        let lua = Lua::new();
        let logger = sub_table(&lua, "logger", super::register);
        lua.globals().set("logger", logger).expect("set global");

        lua.load(
            r#"
            -- Both shapes of the free functions: bare (the DLL's own target)
            -- and namespaced (the caller's target), for all four levels.
            logger.debug("bare debug")
            logger.info("bare info")
            logger.warn("bare warn")
            logger.error("bare error")
            logger.debug("ns debug", "mission.spawn")
            logger.info("ns info", "mission.spawn")
            logger.warn("ns warn", "mission.spawn")
            logger.error("ns error", "mission.spawn")
            "#,
        )
        .exec()
        .expect("level functions");
    }

    /// The `Logger` userdata is the namespaced form modders are told to use:
    /// `logger.Logger.new(ns)` once, then `:info(...)` everywhere. Constructing
    /// it and every method must work through the proxy, and `tostring` must
    /// name the namespace — that string is what shows up when a script prints
    /// a logger by accident, and a raising `__tostring` there would abort the
    /// script.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn the_logger_userdata_carries_its_namespace_through_every_method() {
        let lua = Lua::new();
        let logger = sub_table(&lua, "logger", super::register);
        lua.globals().set("logger", logger).expect("set global");

        let shown: String = lua
            .load(
                r#"
                local log = logger.Logger.new("mission.ai")
                log:debug("d")
                log:info("i")
                log:warn("w")
                log:error("e")
                return tostring(log)
                "#,
            )
            .eval()
            .expect("logger userdata");
        assert_eq!(shown, "Logger(mission.ai)", "tostring names the namespace");
    }
}
