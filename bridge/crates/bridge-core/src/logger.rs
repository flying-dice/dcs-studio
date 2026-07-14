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

    pub fn debug(&self, msg: String) {
        debug!(target: &self.ns, "{}", msg);
    }

    pub fn info(&self, msg: String) {
        info!(target: &self.ns, "{}", msg);
    }

    pub fn warn(&self, msg: String) {
        warn!(target: &self.ns, "{}", msg);
    }

    pub fn error(&self, msg: String) {
        error!(target: &self.ns, "{}", msg);
    }
}

impl UserData for Logger {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_function("new", |_lua: &Lua, ns: String| Ok(Logger::new(ns)));

        methods.add_meta_method(LuaMetaMethod::ToString, |_: &Lua, this, (): ()| {
            Ok(format!("Logger({})", this.ns))
        });

        methods.add_method("debug", |_lua, this, msg: String| {
            this.debug(msg);
            Ok(())
        });

        methods.add_method("info", |_lua, this, msg: String| {
            this.info(msg);
            Ok(())
        });

        methods.add_method("warn", |_lua, this, msg: String| {
            this.warn(msg);
            Ok(())
        });

        methods.add_method("error", |_lua, this, msg: String| {
            this.error(msg);
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
        Some(namespace) => log::log!(target: namespace, level, "{}", msg),
        None => log::log!(level, "{}", msg),
    }
}
