mod json;
mod jsonrpc;
mod logger;
mod lua_utils;
mod module_config;

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
pub fn dcs_bridge(lua: &Lua) -> LuaResult<LuaTable> {
    let module_config: ModuleConfig = lua
        .globals()
        .get::<ModuleConfig>("DCS_BRIDGE")
        .unwrap_or_default();

    let logger_level: LevelFilter = module_config.logger_level.unwrap_or(Warn);

    match init_config(get_logger_file_path(lua)?, logger_level) {
        Ok(_) => info!("Logger initialized successfully"),
        Err(e) => error!("Failed to initialize logger: {}", e),
    };

    let exports = lua.create_table()?;

    exports.set("name", "dcs-bridge")?;
    exports.set("version", env!("CARGO_PKG_VERSION"))?;

    json::inject_module(lua, &exports)?;
    logger::inject_module(lua, &exports)?;
    jsonrpc::inject_module(lua, &exports)?;

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
        return Ok(PathBuf::from(writedir).join("Logs/dcs_bridge.log"));
    }

    if let Ok(current_dir) = env::current_dir() {
        return Ok(current_dir.join("dcs_bridge.log"));
    }

    Ok("./dcs_bridge.log".into())
}

fn get_lfs_writedir(lua: &Lua) -> LuaResult<String> {
    lua.globals()
        .get::<LuaTable>("lfs")?
        .get::<LuaFunction>("writedir")?
        .call(())
}
