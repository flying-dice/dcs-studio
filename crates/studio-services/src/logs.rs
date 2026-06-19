//! Read the DCS World log for the in-IDE log viewer (model `studio::logs`):
//! tail `Saved Games\DCS\Logs\dcs.log` so the developer watches what their
//! script did in-sim — prints, Lua errors, the bridge's `logger` output —
//! without alt-tabbing to the file. A `.dcspkg`-free read of the same write dir
//! the Injection Manager installs into.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// A read of the DCS log tail (model `LogTail`): the most-recent bytes as text,
/// plus whether the file was larger than the cap.
#[derive(Debug, Default, serde::Serialize)]
pub struct LogTail {
    pub text: String,
    pub truncated: bool,
}

/// The DCS log path — `{writeDir}/Logs/dcs.log` — or `None` when no DCS write
/// dir is detected (model `DcsLog.LogPath`).
#[must_use]
pub fn dcs_log_path() -> Option<PathBuf> {
    dcs_studio_project::detect::write_dir().map(|dir| dir.join("Logs").join("dcs.log"))
}

/// Tail the DCS log: at most `max_bytes` from the end of [`dcs_log_path`]
/// (model `DcsLog.Tail`). A multi-megabyte log never loads whole. Empty text
/// when there is no write dir or the log does not exist yet — never an error,
/// so a fresh machine just shows an empty panel.
#[must_use]
pub fn tail(max_bytes: u64) -> LogTail {
    match dcs_log_path() {
        Some(path) => read_tail(&path, max_bytes).unwrap_or_default(),
        None => LogTail::default(),
    }
}

/// Read the last `max_bytes` of `path`. Decoded lossily (DCS logs are UTF-8, but
/// a torn multi-byte char at the seek is tolerated); when the read started past
/// the file's start, the partial first line is dropped so the first visible line
/// is whole. `None` on any IO error (a missing/locked log is just an empty panel).
fn read_tail(path: &Path, max_bytes: u64) -> Option<LogTail> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(max_bytes);
    let truncated = start > 0;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if truncated {
        // The byte cut may land mid-line; drop the partial first line + its
        // newline so the panel never opens on a fragment.
        if let Some(nl) = text.find('\n') {
            text.drain(..=nl);
        }
    }
    Some(LogTail { text, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn tail_returns_the_last_bytes_and_drops_a_torn_first_line() {
        let dir = std::env::temp_dir().join(format!("studio-logs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("dcs.log");
        let mut f = std::fs::File::create(&path).expect("create");
        // Three whole lines; line 1 is long so a small cap slices into it.
        writeln!(f, "{}", "A".repeat(100)).expect("w");
        writeln!(f, "line two").expect("w");
        writeln!(f, "line three").expect("w");
        drop(f);

        // Whole file fits → not truncated, first line intact.
        let whole = read_tail(&path, 10_000).expect("read");
        assert!(!whole.truncated);
        assert!(whole.text.starts_with(&"A".repeat(100)));

        // Small cap → truncated, and the torn line-1 fragment is dropped so the
        // first visible line is a whole line.
        let cut = read_tail(&path, 25).expect("read");
        assert!(cut.truncated);
        assert!(!cut.text.contains('A'), "the torn first line is dropped");
        assert!(cut.text.contains("line three"));
    }

    #[test]
    fn tail_is_empty_when_the_log_is_absent() {
        let missing = Path::new("Z:/no/such/dcs.log");
        assert!(read_tail(missing, 1024).is_none());
    }
}
