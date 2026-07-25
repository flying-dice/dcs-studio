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
use std::error::Error;
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

/// Flatten the failure to a message for the caller to log. The bridge cannot
/// report a logging failure *through* the log, so the cause is stringified here
/// and surfaced to Lua instead — never propagated as a panic.
fn try_init(file: PathBuf, level: LevelFilter) -> Result<(), String> {
    build_and_install(file, level).map_err(|e| e.to_string())
}

/// Build the appender/config and install it as the process logger.
///
/// The three failure modes are all real: an unopenable log path (a writedir
/// that is a file, or a permissions problem), a config the builder rejects,
/// and a second `init_config` in one process. `?` over `Box<dyn Error>` keeps
/// them on one path so [`try_init`] has a single place to stringify.
fn build_and_install(file: PathBuf, level: LevelFilter) -> Result<(), Box<dyn Error>> {
    let appender = FileAppender::builder()
        .append(false)
        .encoder(Box::new(PatternEncoder::new("{d} [{l}] {t} - {m}{n}")))
        .build(file)?;

    let config = Config::builder()
        .appender(
            Appender::builder()
                .filter(Box::new(ThresholdFilter::new(level)))
                .build("appender", Box::new(appender)),
        )
        .build(Root::builder().appender("appender").build(level))?;

    log4rs::init_config(config)?;

    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod tests {
    use super::{init, try_init};
    use log::LevelFilter;

    /// A log path the OS cannot open must come back as an error string, not a
    /// panic: `bootstrap` runs this inside `luaopen`, and a panic there unwinds
    /// through DCS's C stack and takes the sim down. The writedir is
    /// caller-supplied, so an unopenable path is a live possibility (a stale
    /// `__DCS_STUDIO_WRITEDIR`, a read-only install).
    #[test]
    fn an_unopenable_log_path_is_reported_not_panicked() {
        // A path whose parent component is a regular file can never be opened.
        let mut path = std::env::temp_dir();
        path.push(format!("dcs-studio-logging-{}", std::process::id()));
        std::fs::write(&path, b"not a directory").expect("seed blocker file");
        let nested = path.join("dcs_studio_gui.log");

        let err = try_init(nested, LevelFilter::Warn).expect_err("must not open");
        assert!(!err.is_empty(), "the cause must reach the caller");

        std::fs::remove_file(&path).expect("clean up");
    }

    /// The `Once` guard is the whole point of this module: the mission DLL's
    /// `luaopen` re-runs on every mission load, and a second `init` that
    /// actually rebuilt the truncating appender would wipe the log mid-session.
    /// A repeat call must be a silent no-op even when the path is garbage —
    /// proving nothing behind the guard ran.
    #[test]
    fn repeat_init_is_a_no_op_rather_than_a_second_appender() {
        let good = std::env::temp_dir().join(format!("dcs-studio-init-{}.log", std::process::id()));
        // Whichever call wins the `Once` race in this binary, every later one
        // returns Ok without touching log4rs.
        let _ = init(good.clone(), LevelFilter::Warn);
        init(
            std::path::PathBuf::from("/dev/null/nope.log"),
            LevelFilter::Warn,
        )
        .expect("guarded call is a no-op");

        let _ = std::fs::remove_file(&good);
    }

    /// Installing a second logger in one process fails (log's global slot is
    /// write-once). `init` never hits this — the `Once` sees to that — but
    /// `try_init` must still return the cause rather than unwind.
    #[test]
    fn a_second_install_reports_the_logger_conflict() {
        let first = std::env::temp_dir().join(format!("dcs-studio-a-{}.log", std::process::id()));
        let second = std::env::temp_dir().join(format!("dcs-studio-b-{}.log", std::process::id()));

        // The first successful install in this test binary may have already
        // happened via `bootstrap`; either way exactly one succeeds and every
        // subsequent one reports the conflict.
        let outcomes = [
            try_init(first.clone(), LevelFilter::Warn),
            try_init(second.clone(), LevelFilter::Warn),
        ];
        assert!(
            outcomes.iter().any(std::result::Result::is_err),
            "a second install must be refused: {outcomes:?}"
        );

        let _ = std::fs::remove_file(&first);
        let _ = std::fs::remove_file(&second);
    }
}
