//! log4rs setup, guarded by a [`Once`]: the mission DLL's `luaopen` re-runs on
//! every mission load, and without the guard the second load would rebuild the
//! truncating `FileAppender` (`append(false)`) and wipe the log mid-session —
//! `log4rs::init_config` itself also errors on a second init.

use log::LevelFilter;
use log4rs::append::file::FileAppender;
use log4rs::config::{Appender, Root};
use log4rs::encode::pattern::PatternEncoder;
use log4rs::filter::threshold::ThresholdFilter;
use log4rs::Config;
use std::path::PathBuf;
use std::sync::Once;

static INIT: Once = Once::new();

/// Initialize logging into `file` at `level`. Only the first call per DLL does
/// anything; later calls (a new mission re-running `luaopen`) are no-ops.
pub(crate) fn init(file: PathBuf, level: LevelFilter) -> Result<(), String> {
    let mut result = Ok(());
    INIT.call_once(|| {
        result = try_init(file, level);
    });
    result
}

fn try_init(file: PathBuf, level: LevelFilter) -> Result<(), String> {
    let appender = FileAppender::builder()
        .append(false)
        .encoder(Box::new(PatternEncoder::new("{d} [{l}] {t} - {m}{n}")))
        .build(file)
        .map_err(|e| e.to_string())?;

    let config = Config::builder()
        .appender(
            Appender::builder()
                .filter(Box::new(ThresholdFilter::new(level)))
                .build("appender", Box::new(appender)),
        )
        .build(Root::builder().appender("appender").build(level))
        .map_err(|e| e.to_string())?;

    log4rs::init_config(config).map_err(|e| e.to_string())?;

    Ok(())
}
