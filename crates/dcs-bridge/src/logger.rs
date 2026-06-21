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
    fn add_methods<'lua, M: UserDataMethods<Self>>(methods: &mut M) {
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
    type LevelFn = fn(&Lua, (String, Option<String>)) -> Result<()>;
    let levels: [(&str, &str, LevelFn); 4] = [
        ("debug", "Log a message at debug level.", debug),
        ("info", "Log a message at info level.", info),
        ("warn", "Log a message at warn level.", warn),
        ("error", "Log a message at error level.", error),
    ];
    for (name, doc, f) in levels {
        sub.func(
            name,
            &[p("msg", "string"), p_opt("ns", "string")],
            &[],
            doc,
            f,
        )?;
    }

    sub.proxy::<Logger>("Logger", "A namespaced logger writing to the DCS Studio log.", |ud| {
        ud.constructor(
            "new",
            &[p("ns", "string")],
            &[r("dcs_studio.logger.Logger")],
            "Create a logger that tags every line with namespace `ns`.",
        )
        .method("debug", &[p("msg", "string")], &[], "Log at debug level under this logger's namespace.")
        .method("info", &[p("msg", "string")], &[], "Log at info level under this logger's namespace.")
        .method("warn", &[p("msg", "string")], &[], "Log at warn level under this logger's namespace.")
        .method("error", &[p("msg", "string")], &[], "Log at error level under this logger's namespace.");
    })?;

    Ok(())
}

fn debug(_: &Lua, (msg, ns): (String, Option<String>)) -> Result<()> {
    match ns {
        Some(namespace) => debug!(target: &namespace, "{}", msg),
        None => debug!("{}", msg),
    }
    Ok(())
}

fn info(_: &Lua, (msg, ns): (String, Option<String>)) -> Result<()> {
    match ns {
        Some(namespace) => info!(target: &namespace, "{}", msg),
        None => info!("{}", msg),
    }
    Ok(())
}

fn warn(_: &Lua, (msg, ns): (String, Option<String>)) -> Result<()> {
    match ns {
        Some(namespace) => warn!(target: &namespace, "{}", msg),
        None => warn!("{}", msg),
    }
    Ok(())
}

fn error(_: &Lua, (msg, ns): (String, Option<String>)) -> Result<()> {
    match ns {
        Some(namespace) => error!(target: &namespace, "{}", msg),
        None => error!("{}", msg),
    }
    Ok(())
}
