mod debug;
mod facade;
mod file;
mod globals;
mod json;
mod jsonrpc;
mod logger;
mod lua_utils;
mod module_config;
mod sqlite;
mod surface;
mod toml_codec;

use log::LevelFilter::Warn;
use log::{error, info, LevelFilter};
use log4rs::append::file::FileAppender;
use log4rs::config::{Appender, Root};
use log4rs::encode::pattern::PatternEncoder;
use log4rs::filter::threshold::ThresholdFilter;
use log4rs::Config;
use mlua::prelude::{LuaFunction, LuaResult, LuaTable};
use mlua::{ExternalError, Lua};
use module_config::ModuleConfig;
use std::env;
use std::path::PathBuf;

#[mlua::lua_module]
pub fn dcs_studio(lua: &Lua) -> LuaResult<LuaTable> {
    let module_config: ModuleConfig = lua
        .globals()
        .get::<ModuleConfig>("DCS_STUDIO")
        .unwrap_or_default();

    let logger_level: LevelFilter = module_config.logger_level.unwrap_or(Warn);

    match init_config(get_logger_file_path(lua)?, logger_level) {
        Ok(_) => info!("Logger initialized successfully"),
        Err(e) => error!("Failed to initialize logger: {}", e),
    };

    let exports = lua.create_table()?;

    // Register every binding through the facade and capture its `.d.lua` type
    // surface (name/version are set as constants inside `build`).
    let doc = surface::build(lua, &exports, env!("CARGO_PKG_VERSION"))?;

    // `emit_dlua()` returns the generated EmmyLua definitions for this module,
    // so the IDE can drop a fresh `types/dcs_studio.d.lua` into a project. The
    // text is rendered once at load and handed back verbatim.
    let dlua = dcs_studio_project::luadef::emit_dlua(&doc);
    exports.set(
        "emit_dlua",
        lua.create_function(move |_, ()| Ok(dlua.clone()))?,
    )?;

    // `dump_globals()` introspects the live DCS API in `_G` (the curated roots
    // in `globals::CURATED_ROOTS`) and returns it as dotted `.d.lua` statements
    // the editor indexes. Unlike `emit_dlua`, it runs per call: `_G` gains
    // mission-state globals once a mission loads, so the dump must reflect the
    // sim's CURRENT surface, not a snapshot taken at module load.
    exports.set(
        "dump_globals",
        lua.create_function(|lua, ()| Ok(globals::dump_globals(lua)))?,
    )?;

    Ok(exports)
}

pub fn init_config(file: PathBuf, level: LevelFilter) -> mlua::Result<()> {
    let appender = FileAppender::builder()
        .append(false)
        .encoder(Box::new(PatternEncoder::new("{d} [{l}] {t} - {m}{n}")))
        .build(file)
        .map_err(|e| e.into_lua_err())?;

    // Build the logging configuration
    let config = Config::builder()
        .appender(
            Appender::builder()
                .filter(Box::new(ThresholdFilter::new(level)))
                .build("appender", Box::new(appender)),
        )
        .build(Root::builder().appender("appender").build(level))
        .map_err(|e| e.into_lua_err())?;

    log4rs::init_config(config).map_err(|e| e.into_lua_err())?;

    Ok(())
}

fn get_logger_file_path(lua: &Lua) -> LuaResult<PathBuf> {
    if let Ok(writedir) = get_lfs_writedir(lua) {
        return Ok(PathBuf::from(writedir).join("Logs/dcs_studio.log"));
    }

    if let Ok(current_dir) = env::current_dir() {
        return Ok(current_dir.join("dcs_studio.log"));
    }

    Ok("./dcs_studio.log".into())
}

pub(crate) fn get_lfs_writedir(lua: &Lua) -> LuaResult<String> {
    lua.globals()
        .get::<LuaTable>("lfs")?
        .get::<LuaFunction>("writedir")?
        .call(())
}
