//! The editor's Format command (model: `studio::edit::Formatting`).
//!
//! Formats the active buffer through the SAME engine the CLI `fmt` /
//! `fmt --check` runs (`crates/dcs-lua-fmt`) over the SAME `[format]` config
//! resolved from `dcs-studio.toml` (`dcs_studio_project::format_config_for`)
//! — so a buffer formatted in the editor is byte-for-byte what CI checks; they
//! cannot disagree. A thin command: the buffer text crosses from the webview
//! and the formatted text crosses back. Applying it (the CodeMirror
//! transaction and caret) and the dirty-buffer/save path stay the frontend's
//! job, unchanged.

use std::path::Path;

use dcs_lua_fmt::Span;

/// A formatting outcome for the webview (model: `fmt::Formatted`). `text` is
/// the formatted source — or the input returned unchanged when the semantic
/// guard tripped.
#[derive(serde::Serialize)]
pub struct FormatResult {
    pub text: String,
    /// The semantic guard rejected the printed text and `text` is the input
    /// unchanged — always a formatter bug. The editor warns and keeps the
    /// buffer as-is; it never aborts (model: `fmt::Fmt` PreservesSemantics).
    pub guard_tripped: bool,
}

/// Format Lua `text` belonging to the file at `path` (its enclosing
/// `dcs-studio.toml` `[format]` governs style; house defaults when absent or
/// unreadable). With `range = Some([start, end])` only the smallest run of
/// whole statements enclosing the byte range is reformatted (Format
/// Selection), every other byte identical; `None` formats the whole document
/// (Format Document).
///
/// # Errors
///
/// A buffer that does not parse returns `Err` carrying the first parse
/// diagnostic (`<code> <message>`) — the caller keeps the original text,
/// never a half-formatted buffer (model: `studio::edit::Formatting`).
#[tauri::command]
pub fn format_source(
    path: String,
    text: String,
    range: Option<[u32; 2]>,
) -> Result<FormatResult, String> {
    let config = dcs_studio_project::format_config_for(Path::new(&path));
    let outcome = match range {
        Some([start, end]) => dcs_lua_fmt::format_range(&text, Span::new(start, end), &config),
        None => dcs_lua_fmt::format(&text, &config),
    };
    match outcome {
        Ok(formatted) => Ok(FormatResult {
            text: formatted.text,
            guard_tripped: formatted.guard_tripped,
        }),
        Err(diagnostics) => Err(diagnostics
            .first()
            .map(|d| format!("{} {}", d.code, d.message))
            .unwrap_or_else(|| "does not parse".to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway directory under the system temp dir; removed on drop so a
    /// panicking assertion never leaks a fixture.
    struct TempTree(std::path::PathBuf);

    impl TempTree {
        fn new(tag: &str) -> Self {
            let root =
                std::env::temp_dir().join(format!("dcs-fmt-cmd-test-{tag}-{}", std::process::id()));
            std::fs::create_dir_all(&root).expect("create temp root");
            TempTree(root)
        }
        /// Write `contents` at `rel` and return its absolute path (as the
        /// `String` the command takes).
        fn file(&self, rel: &str, contents: &str) -> String {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).expect("create parent");
            std::fs::write(&path, contents).expect("write file");
            path.to_string_lossy().into_owned()
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn formats_whole_document_idempotently() {
        let tree = TempTree::new("doc");
        // No manifest up the tree → house defaults. Messy spacing normalises.
        let path = tree.file("m.lua", "local    x   =    1\n");
        let first = format_source(path.clone(), "local    x   =    1\n".into(), None)
            .expect("parseable source formats");
        assert!(!first.guard_tripped);
        assert_ne!(
            first.text, "local    x   =    1\n",
            "messy input is reformatted"
        );
        // Formatting its own output is a fixpoint (model FormatIsIdempotent).
        let second =
            format_source(path, first.text.clone(), None).expect("formatted source re-formats");
        assert_eq!(second.text, first.text);
    }

    #[test]
    fn honors_format_config_from_manifest() {
        let tree = TempTree::new("config");
        tree.file(
            "dcs-studio.toml",
            "[project]\nname = \"x\"\n\n[format]\nindent_width = 2\n",
        );
        let path = tree.file("src/m.lua", "do\nlocal x = 1\nend\n");
        let out = format_source(path, "do\nlocal x = 1\nend\n".into(), None)
            .expect("parseable source formats");
        // indent_width = 2 from the manifest, not the house default of 4.
        assert!(
            out.text.contains("\n  local x = 1\n"),
            "block body indented two spaces, got {:?}",
            out.text
        );
        assert!(!out.text.contains("\n    local x = 1\n"));
    }

    #[test]
    fn range_reformats_only_the_enclosing_run() {
        let tree = TempTree::new("range");
        let src = "local a=1\nlocal b=2\n";
        let path = tree.file("m.lua", src);
        // The range covers only the first statement ("local a=1", bytes 0..9).
        // It is reformatted ("local a = 1"); the second line is outside the
        // run, so it stays byte-identical — the messy `b=2` survives verbatim
        // (a whole-doc format would have spaced it to `b = 2`).
        let out = format_source(path, src.into(), Some([0, 9])).expect("formats");
        assert_ne!(out.text, src, "the in-range statement is reformatted");
        assert!(
            out.text.contains("local b=2"),
            "out-of-range bytes are untouched, got {:?}",
            out.text
        );
    }

    #[test]
    fn unparseable_source_is_an_error() {
        let tree = TempTree::new("broken");
        let src = "local = = =\n";
        let path = tree.file("m.lua", src);
        let result = format_source(path, src.into(), None);
        assert!(result.is_err(), "a syntax error surfaces as Err");
    }
}
