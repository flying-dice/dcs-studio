//! Startup CLI arguments for the app binary.
//!
//! `dcs-studio --open <path>` (or `-o <path>`, `--open=<path>`) launches with a
//! project already opened — the frontend reads it via `startup_open` on boot
//! and runs the normal open-project flow (model/studio/core.pds OpenProject).
//! This is how the e2e suite points the real app at a fixture project on disk,
//! so the hosted `lua-analyzer` walks a real workspace instead of a stand-in.

use tauri::State;

/// Parsed startup arguments, managed so any command can read them.
#[derive(Debug, Default)]
pub struct StartupArgs {
    /// The project path to open on boot, from `--open`, if any.
    pub open: Option<String>,
}

impl StartupArgs {
    /// Parse the process arguments (the program name is skipped). Accepts
    /// `--open <path>`, `-o <path>`, and `--open=<path>`; the last wins.
    #[must_use]
    pub fn parse<I: IntoIterator<Item = String>>(args: I) -> Self {
        let mut open = None;
        let mut iter = args.into_iter().skip(1);
        while let Some(arg) = iter.next() {
            if arg == "--open" || arg == "-o" {
                open = iter.next();
            } else if let Some(rest) = arg.strip_prefix("--open=") {
                open = Some(rest.to_string());
            }
        }
        Self { open }
    }
}

/// The project path the app was asked to open on boot, if any. The frontend
/// calls this once on mount and runs its open-project flow when it is `Some`.
#[tauri::command]
pub fn startup_open(state: State<'_, StartupArgs>) -> Option<String> {
    state.open.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Option<String> {
        StartupArgs::parse(args.iter().map(ToString::to_string)).open
    }

    #[test]
    fn no_args_opens_nothing() {
        assert_eq!(parse(&["dcs-studio"]), None);
    }

    #[test]
    fn open_takes_the_following_path() {
        assert_eq!(parse(&["dcs-studio", "--open", "C:/proj"]), Some("C:/proj".into()));
        assert_eq!(parse(&["dcs-studio", "-o", "C:/proj"]), Some("C:/proj".into()));
    }

    #[test]
    fn open_equals_form_is_accepted() {
        assert_eq!(parse(&["dcs-studio", "--open=C:/proj"]), Some("C:/proj".into()));
    }

    #[test]
    fn a_trailing_open_with_no_value_is_ignored() {
        assert_eq!(parse(&["dcs-studio", "--open"]), None);
    }

    #[test]
    fn the_last_open_wins() {
        assert_eq!(
            parse(&["dcs-studio", "--open", "C:/a", "--open=C:/b"]),
            Some("C:/b".into())
        );
    }
}
