// DCS log viewer command: a thin Tauri wrapper over studio-services::logs
// (model/studio/logs.pds — issue #47 debugging companion).

pub use studio_services::logs::LogTail;

/// Read the tail of the DCS log (`{writeDir}\Logs\dcs.log`) — at most
/// `max_bytes` from the end, so a multi-MB log never loads whole. Empty when no
/// DCS write dir or log is present yet (never an error).
#[tauri::command]
pub fn dcs_log_tail(max_bytes: u64) -> LogTail {
    studio_services::logs::tail(max_bytes)
}
