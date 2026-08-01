//! log4rs setup: an APPENDING, size-rolled log file, installed once per DLL
//! image.
//!
//! Two guards, and they cover different things — which is the whole history of
//! this module.
//!
//! The [`Once`] covers a second `luaopen` in the SAME loaded DLL: the mission
//! DLL's entry point re-runs on every mission load, and `log4rs::init_config`
//! errors on a second init because `log`'s global logger slot is write-once.
//!
//! What it cannot cover is a DLL image that goes away and comes back. Card 30's
//! live session watched `dcs_studio_mission.log` SHRINK across a mission change
//! (19,812 → 6,899 bytes): the mission Lua state closes on unload, which drops
//! Lua's `loadlib` handle and unloads the DLL, so the next mission gets fresh
//! statics — a fresh `Once`, a fresh logger slot, and, back when this built a
//! `FileAppender` with `append(false)`, a fresh truncation. Mission 1's
//! diagnostics were gone exactly when a post-mortem of its unload wanted them,
//! and the card-18 teardown line was among the losses.
//!
//! So the file is opened for APPEND and nothing ever truncates it. The one
//! thing truncation was buying — a bound on growth across a long multi-mission
//! session — is bought instead by log4rs's own rolling machinery: a size
//! trigger at [`LOG_SIZE_LIMIT_BYTES`] and a fixed-window roller of exactly one
//! file, so the log occupies at most `<name>.log` plus `<name>.log.1` forever.
//! That is a bound the process-lifetime guard never actually gave: a single
//! mission running at `trace` could grow the file without limit.
//!
//! Runs are therefore delimited by their timestamps rather than by the file
//! starting over, and a DCS restart appends to the previous run's tail — which
//! is the point. None of this is load-bearing for serving (card 20): `init`
//! still returns its failure as a string, `bootstrap` logs it and carries on,
//! and a bridge that cannot open its log is still a working bridge.

use log::LevelFilter;
use log4rs::append::rolling_file::policy::compound::roll::fixed_window::FixedWindowRoller;
use log4rs::append::rolling_file::policy::compound::trigger::size::SizeTrigger;
use log4rs::append::rolling_file::policy::compound::CompoundPolicy;
use log4rs::append::rolling_file::RollingFileAppender;
use log4rs::config::{Appender, Root};
use log4rs::encode::pattern::PatternEncoder;
use log4rs::filter::threshold::ThresholdFilter;
use log4rs::Config;
use std::error::Error;
use std::path::Path;
use std::sync::Once;

static INIT: Once = Once::new();

/// Roll the log at 8 MiB. With a one-file window that caps a DLL's logs at
/// 16 MiB however long DCS runs and however many missions it loads. Generous at
/// the shipped `warn` level (card 16) — where a whole session is kilobytes —
/// and a real ceiling at `trace`, which is the level that can actually run
/// away.
const LOG_SIZE_LIMIT_BYTES: u64 = 8 * 1024 * 1024;

/// Keep exactly one rolled generation: `dcs_studio_mission.log.1`. Two files is
/// what a post-mortem needs (the mission that just ended, and the one before
/// it); more is a disk budget nobody asked this bridge to spend.
const ROLLED_GENERATIONS: u32 = 1;

/// Initialize logging into `file` at `level`. Only the first call per LOADED
/// DLL IMAGE does anything; later calls in the same image (a new mission
/// re-running `luaopen` before the image is dropped) are no-ops. A reload gets a
/// fresh `Once` and installs again — which is safe now that the file is opened
/// for append rather than truncated.
pub(crate) fn init(file: &Path, level: LevelFilter) -> Result<(), String> {
    let mut result = Ok(());
    INIT.call_once(|| {
        result = try_init(file, level);
    });
    result
}

/// Flatten the failure to a message for the caller to log. The bridge cannot
/// report a logging failure *through* the log, so the cause is stringified here
/// and surfaced to Lua instead — never propagated as a panic.
fn try_init(file: &Path, level: LevelFilter) -> Result<(), String> {
    build_and_install(file, level).map_err(|e| e.to_string())
}

/// The appending, size-rolled file appender this module installs — and the unit
/// the tests drive, since installing one is a once-per-process act and the
/// behaviour worth pinning is the file's, not the global logger's.
///
/// `append(true)` is the fix for card 32; the policy beside it is what keeps
/// that from being unbounded. The roller's pattern appends `.1` to the log's
/// own name rather than replacing an extension, so the rolled file sits next to
/// the live one under an obviously related name.
fn build_appender(file: &Path) -> Result<RollingFileAppender, Box<dyn Error>> {
    let roller = FixedWindowRoller::builder()
        .base(1)
        .build(&format!("{}.{{}}", file.display()), ROLLED_GENERATIONS)?;
    let policy = CompoundPolicy::new(
        Box::new(SizeTrigger::new(LOG_SIZE_LIMIT_BYTES)),
        Box::new(roller),
    );
    let appender = RollingFileAppender::builder()
        .append(true)
        .encoder(Box::new(PatternEncoder::new("{d} [{l}] {t} - {m}{n}")))
        .build(file, Box::new(policy))?;
    Ok(appender)
}

/// Build the appender/config and install it as the process logger.
///
/// The three failure modes are all real: an unopenable log path (a writedir
/// that is a file, or a permissions problem), a config the builder rejects,
/// and a second `init_config` in one process. `?` over `Box<dyn Error>` keeps
/// them on one path so [`try_init`] has a single place to stringify.
fn build_and_install(file: &Path, level: LevelFilter) -> Result<(), Box<dyn Error>> {
    let appender = build_appender(file)?;

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
    use super::{build_appender, init, try_init, LOG_SIZE_LIMIT_BYTES};
    use log::LevelFilter;
    use log4rs::append::Append;
    use std::path::{Path, PathBuf};

    /// A scratch log path unique to this test binary and case, cleaned up by
    /// the caller. Named after the case so a failure names its own file.
    fn scratch(case: &str) -> PathBuf {
        std::env::temp_dir().join(format!("dcs-studio-{case}-{}.log", std::process::id()))
    }

    /// Push one record through an appender, exactly as the `log` macros would.
    fn write_line(appender: &dyn Append, msg: &str) {
        appender
            .append(&log::Record::builder().args(format_args!("{msg}")).build())
            .expect("append a record");
        appender.flush();
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap_or_default()
    }

    /// The card-32 regression, and the reason this appender exists.
    ///
    /// Every mission load re-runs the mission DLL's `luaopen`, and the DLL image
    /// itself does not survive the mission Lua state that loaded it — so the
    /// `Once` above is fresh for mission 2 and the appender really is rebuilt.
    /// While it truncated, that wiped mission 1's diagnostics at exactly the
    /// moment someone wanted to read them: card 30 watched the file shrink from
    /// 19,812 to 6,899 bytes across a mission change, taking the card-18
    /// teardown line with it.
    ///
    /// Building the appender twice over one path is that reload, modelled at the
    /// level where the behaviour lives — a second `init` in this process is a
    /// no-op by design (the test below), so it could never have caught this.
    #[test]
    fn a_rebuilt_appender_keeps_what_the_previous_one_wrote() {
        let path = scratch("append");
        let _ = std::fs::remove_file(&path);

        let first = build_appender(&path).expect("first appender");
        write_line(&first, "mission one unloaded cleanly");
        drop(first);

        // The mission changes: the DLL is loaded again and builds its appender
        // again, over the same path.
        let second = build_appender(&path).expect("second appender");
        write_line(&second, "mission two is serving");
        drop(second);

        let body = read(&path);
        assert!(
            body.contains("mission one unloaded cleanly"),
            "the first bootstrap's lines were destroyed by the second: {body:?}"
        );
        assert!(
            body.contains("mission two is serving"),
            "the second bootstrap logged into the same file: {body:?}"
        );

        let _ = std::fs::remove_file(&path);
    }

    /// Appending forever is only safe because the size trigger bounds it. Past
    /// the limit the live file rolls to `<name>.log.1` and starts again, so a
    /// long multi-mission session at `trace` costs at most two files' worth of
    /// disk — the bound the old truncate-per-load never actually gave, since one
    /// mission could grow the file without limit.
    #[test]
    fn growth_is_bounded_by_a_single_roll_rather_than_by_truncation() {
        let path = scratch("roll");
        let rolled = PathBuf::from(format!("{}.1", path.display()));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&rolled);

        // Seed the file past the trigger before the appender opens it, so the
        // test costs one write rather than 8 MiB of them. The trigger inspects
        // the file's length, which is what makes this faithful.
        let oversized = usize::try_from(LOG_SIZE_LIMIT_BYTES).expect("64-bit host") + 1;
        std::fs::write(&path, vec![b'x'; oversized]).expect("seed a big log");

        let appender = build_appender(&path).expect("appender");
        // log4rs writes the record and THEN consults the trigger, so this line
        // is the last one in the outgoing file rather than the first of the new
        // one. Which is the right way round: a record is never held hostage to
        // a roll.
        write_line(&appender, "the line that tipped it over");
        write_line(&appender, "and the one after the roll");
        drop(appender);

        let rolled_name = rolled.display().to_string();
        assert!(
            rolled.is_file(),
            "the oversized log did not roll to {rolled_name}"
        );
        let rolled_body = read(&rolled);
        assert!(
            rolled_body.starts_with("xxx") && rolled_body.contains("the line that tipped it over"),
            "the rolled file holds what the live one used to, up to the roll"
        );
        let live = read(&path);
        assert!(
            live.contains("and the one after the roll"),
            "logging carried on into the fresh file: {live:?}"
        );
        let live_len = live.len() as u64;
        assert!(
            live_len < LOG_SIZE_LIMIT_BYTES,
            "the live file was not restarted by the roll: {live_len} bytes"
        );

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&rolled);
    }

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

        let err = try_init(&nested, LevelFilter::Warn).expect_err("must not open");
        assert!(!err.is_empty(), "the cause must reach the caller");

        std::fs::remove_file(&path).expect("clean up");
    }

    /// The `Once` guard covers a second `luaopen` in the same loaded image: the
    /// mission DLL's entry point re-runs on every mission load, and
    /// `log4rs::init_config` errors on a second init because `log`'s global
    /// slot is write-once. A repeat call must be a silent no-op even when the
    /// path is garbage — proving nothing behind the guard ran. (What it cannot
    /// cover is an image that goes away and comes back; that is the appending
    /// appender's job, above.)
    #[test]
    fn repeat_init_is_a_no_op_rather_than_a_second_appender() {
        let good = std::env::temp_dir().join(format!("dcs-studio-init-{}.log", std::process::id()));
        // Whichever call wins the `Once` race in this binary, every later one
        // returns Ok without touching log4rs.
        let _ = init(&good, LevelFilter::Warn);
        init(Path::new("/dev/null/nope.log"), LevelFilter::Warn).expect("guarded call is a no-op");

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
            try_init(&first, LevelFilter::Warn),
            try_init(&second, LevelFilter::Warn),
        ];
        assert!(
            outcomes.iter().any(std::result::Result::is_err),
            "a second install must be refused: {outcomes:?}"
        );

        let _ = std::fs::remove_file(&first);
        let _ = std::fs::remove_file(&second);
    }
}
