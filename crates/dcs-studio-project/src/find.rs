//! Project-wide find-in-files behind the IDE's search overlay
//! (model: `studio::core::Workbench` search — `SearchWorkspace`, issue #68).
//!
//! A regex matcher over the workspace that reuses the Todos scanner's walk and
//! skip rules: gitignore-aware ([`WalkBuilder`]), files over
//! [`crate::todos::MAX_FILE_BYTES`] skipped, non-UTF-8 (binary) files skipped,
//! and never failing on an unreadable file — an unreadable file simply
//! contributes no matches.
//!
//! One [`regex::Regex`] covers all four option combinations: literal vs regex
//! (the query is `regex::escape`d for literal mode, used raw for regex mode),
//! whole-word (the pattern wrapped in `\b(?:…)\b`), and case sensitivity
//! (`RegexBuilder::case_insensitive` — searches are case-insensitive by
//! default, like the editor's). An invalid regex is reported as a
//! [`FindError`] so the overlay can show an inline hint instead of results.
//!
//! The walk stops once [`MAX_MATCHES`] hits are collected and flags the result
//! [`FindResult::truncated`], so the overlay never silently drops matches.

use std::path::Path;

use ignore::WalkBuilder;
use regex::{Regex, RegexBuilder};

use crate::todos::MAX_FILE_BYTES;

/// Most matches a single search collects before it stops and flags the result
/// truncated (model `studio::core::SEARCH_MATCH_CAP`).
pub const MAX_MATCHES: usize = 2000;

/// Match options for a search: literal vs regex, case sensitivity, whole-word
/// (model `studio::core::SearchOptions`). Deserialised from the camelCase shape
/// the frontend store sends.
#[derive(Debug, Clone, Copy, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
}

/// One search hit. `line` is 1-based; `column` is 1-based and `length` is a
/// span, both counting UTF-16 code units (the editor caret's coordinates plus
/// the matched span the overlay highlights). `text` is the matching line — the
/// result row's content (model `studio::core::SearchHit`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FindMatch {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub length: u32,
    pub text: String,
}

/// The outcome of a search: the hits (capped at [`MAX_MATCHES`]) and whether
/// that cap truncated them (model `studio::core::SearchResult`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FindResult {
    pub matches: Vec<FindMatch>,
    pub truncated: bool,
}

/// Why a search produced no hit list rather than matches: an invalid regex
/// pattern (model `studio::core::SearchError`). Serialised as the error the
/// Tauri command returns and the overlay shows inline.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FindError {
    pub message: String,
}

/// Search every non-ignored file under `root` for `query`, sorted by path then
/// line then column. An empty query yields no matches (the overlay clears its
/// results without searching). An invalid regex (regex mode) returns
/// [`FindError`]. The walk skips non-files, files over [`MAX_FILE_BYTES`], and
/// non-UTF-8 files, and never fails on an unreadable file. Collection stops at
/// [`MAX_MATCHES`] with [`FindResult::truncated`] set.
///
/// # Errors
/// Returns [`FindError`] when `opts.regex` is set and `query` is not a valid
/// regular expression (a `regex::escape`d literal can never fail to compile).
pub fn find_in_files(root: &Path, query: &str, opts: FindOptions) -> Result<FindResult, FindError> {
    if query.is_empty() {
        return Ok(FindResult {
            matches: Vec::new(),
            truncated: false,
        });
    }
    let regex = build_regex(query, opts)?;
    let mut matches = Vec::new();
    let mut truncated = false;
    let walker = WalkBuilder::new(root)
        // Respect .gitignore even when the workspace is not a git repo
        // (fresh projects, test fixtures) — mirrors `todos::scan`.
        .require_git(false)
        .build();
    'walk: for dent in walker.flatten() {
        if !dent.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Some(text) = read_text(dent.path()) else {
            continue;
        };
        let path = dent.path().to_string_lossy().to_string();
        for (line_idx, line) in text.lines().enumerate() {
            for m in regex.find_iter(line) {
                // A zero-width match (e.g. `a*` against a line with no `a`,
                // `^`, `\b`) highlights nothing and would otherwise spam a hit
                // at every position — skip it.
                if m.start() == m.end() {
                    continue;
                }
                if matches.len() >= MAX_MATCHES {
                    truncated = true;
                    break 'walk;
                }
                matches.push(FindMatch {
                    path: path.clone(),
                    line: u32::try_from(line_idx + 1).unwrap_or(u32::MAX),
                    column: utf16_len(&line[..m.start()]) + 1,
                    length: utf16_len(m.as_str()),
                    text: line.to_string(),
                });
            }
        }
    }
    matches.sort_by(|a, b| {
        a.path
            .cmp(&b.path)
            .then(a.line.cmp(&b.line))
            .then(a.column.cmp(&b.column))
    });
    Ok(FindResult { matches, truncated })
}

/// Compile the one regex covering the option combination: literal queries are
/// `regex::escape`d, whole-word wraps the pattern in `\b(?:…)\b`, and the
/// search is case-insensitive unless `case_sensitive` is set.
fn build_regex(query: &str, opts: FindOptions) -> Result<Regex, FindError> {
    let core = if opts.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let pattern = if opts.whole_word {
        format!(r"\b(?:{core})\b")
    } else {
        core
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!opts.case_sensitive)
        .build()
        .map_err(|err| FindError {
            message: format!("invalid pattern: {err}"),
        })
}

/// Read a file as text for matching, applying the Todos scanner's skip rules:
/// oversized (> [`MAX_FILE_BYTES`]), non-UTF-8, or unreadable files yield
/// `None` (no matches), never an error.
fn read_text(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    String::from_utf8(bytes).ok()
}

fn utf16_len(s: &str) -> u32 {
    u32::try_from(s.encode_utf16().count()).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dcs-find-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn opts(case_sensitive: bool, whole_word: bool, regex: bool) -> FindOptions {
        FindOptions {
            case_sensitive,
            whole_word,
            regex,
        }
    }

    #[test]
    fn finds_literal_matches_across_nested_dirs_sorted() {
        let root = temp_root("nested");
        fs::create_dir_all(root.join("sub/deeper")).expect("dirs");
        fs::write(root.join("sub/deeper/b.lua"), "print(1)\nlocal needle = 2\n").expect("file");
        fs::write(root.join("a.lua"), "-- needle here\nprint(2)\n").expect("file");

        let result = find_in_files(&root, "needle", opts(false, false, false)).expect("ok");

        assert!(!result.truncated);
        assert_eq!(result.matches.len(), 2, "{:?}", result.matches);
        // Sorted by path then line: a.lua before sub/deeper/b.lua.
        assert!(result.matches[0].path.ends_with("a.lua"));
        assert_eq!(result.matches[0].line, 1);
        assert_eq!(result.matches[0].column, 4, "1-based column of the match");
        assert_eq!(result.matches[0].length, 6, "len(\"needle\")");
        assert_eq!(result.matches[0].text, "-- needle here", "row is the whole line");
        assert!(result.matches[1].path.ends_with("b.lua"));
        assert_eq!(result.matches[1].line, 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn case_insensitive_by_default_and_sensitive_when_set() {
        let root = temp_root("case");
        fs::write(root.join("f.lua"), "Needle\nneedle\nNEEDLE\n").expect("file");

        let insensitive = find_in_files(&root, "needle", opts(false, false, false)).expect("ok");
        assert_eq!(insensitive.matches.len(), 3, "default ignores case");

        let sensitive = find_in_files(&root, "needle", opts(true, false, false)).expect("ok");
        assert_eq!(sensitive.matches.len(), 1, "case-sensitive matches one");
        assert_eq!(sensitive.matches[0].line, 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn whole_word_respects_boundaries() {
        let root = temp_root("word");
        fs::write(root.join("f.lua"), "cat\ncategory\nscatter\n").expect("file");

        let loose = find_in_files(&root, "cat", opts(false, false, false)).expect("ok");
        assert_eq!(loose.matches.len(), 3, "substring matches everywhere");

        let whole = find_in_files(&root, "cat", opts(false, true, false)).expect("ok");
        assert_eq!(whole.matches.len(), 1, "{:?}", whole.matches);
        assert_eq!(whole.matches[0].line, 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn regex_mode_matches_pattern_literal_does_not() {
        let root = temp_root("regex");
        fs::write(root.join("f.lua"), "foo\nfxo\nf.o\n").expect("file");

        let re = find_in_files(&root, "f.o", opts(true, false, true)).expect("ok");
        assert_eq!(re.matches.len(), 3, "the dot is any-char in regex mode");

        let lit = find_in_files(&root, "f.o", opts(true, false, false)).expect("ok");
        assert_eq!(lit.matches.len(), 1, "the dot is literal otherwise");
        assert_eq!(lit.matches[0].line, 3);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn invalid_regex_returns_err() {
        let root = temp_root("bad-regex");
        fs::write(root.join("f.lua"), "anything\n").expect("file");

        let err = find_in_files(&root, "(unclosed", opts(false, false, true)).expect_err("err");
        assert!(err.message.contains("invalid pattern"), "{}", err.message);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cap_truncates_without_silent_drop() {
        let root = temp_root("cap");
        let mut body = String::new();
        for _ in 0..(MAX_MATCHES + 100) {
            body.push_str("needle\n");
        }
        fs::write(root.join("big.lua"), body).expect("file");

        let result = find_in_files(&root, "needle", opts(false, false, false)).expect("ok");

        assert!(result.truncated, "the cap was hit");
        assert_eq!(result.matches.len(), MAX_MATCHES, "stops exactly at the cap");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn gitignored_oversize_and_binary_files_are_skipped() {
        let root = temp_root("skips");
        fs::create_dir_all(root.join("generated")).expect("dirs");
        fs::write(root.join(".gitignore"), "generated/\n").expect("gitignore");
        fs::write(root.join("generated/ignored.lua"), "needle ignored\n").expect("file");
        let mut big = String::from("needle big\n");
        big.push_str(&"x".repeat(usize::try_from(MAX_FILE_BYTES).expect("usize") + 1));
        fs::write(root.join("big.lua"), big).expect("file");
        fs::write(root.join("blob.bin"), [b'n', b'e', b'e', b'd', b'l', b'e', 0xff, 0xfe])
            .expect("binary");
        fs::write(root.join("kept.lua"), "needle kept\n").expect("file");

        let result = find_in_files(&root, "needle", opts(false, false, false)).expect("ok");

        assert_eq!(result.matches.len(), 1, "only kept.lua: {:?}", result.matches);
        assert!(result.matches[0].path.ends_with("kept.lua"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn column_counts_utf16_code_units_not_bytes() {
        let root = temp_root("utf16");
        // The multibyte prefix makes byte and UTF-16 offsets diverge: the
        // editor caret (UTF-16) only lands on the match if columns count UTF-16.
        let line = "-- наводка needle here";
        fs::write(root.join("f.lua"), format!("{line}\n")).expect("file");

        let result = find_in_files(&root, "needle", opts(false, false, false)).expect("ok");

        assert_eq!(result.matches.len(), 1);
        let expected = u32::try_from(
            line[..line.find("needle").expect("present")]
                .encode_utf16()
                .count(),
        )
        .expect("fits")
            + 1;
        assert_eq!(result.matches[0].column, expected);
        assert_ne!(
            u64::from(result.matches[0].column),
            line.find("needle").expect("present") as u64 + 1,
            "the fixture really discriminates bytes from UTF-16"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn multiple_matches_on_one_line_each_get_a_row() {
        let root = temp_root("multi");
        fs::write(root.join("f.lua"), "foo foo foo\n").expect("file");

        let result = find_in_files(&root, "foo", opts(false, false, false)).expect("ok");

        assert_eq!(result.matches.len(), 3, "one row per occurrence");
        assert_eq!(result.matches[0].column, 1);
        assert_eq!(result.matches[1].column, 5);
        assert_eq!(result.matches[2].column, 9);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_query_yields_no_matches() {
        let root = temp_root("empty");
        fs::write(root.join("f.lua"), "anything at all\n").expect("file");

        let result = find_in_files(&root, "", opts(false, false, false)).expect("ok");

        assert!(result.matches.is_empty());
        assert!(!result.truncated);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn zero_width_regex_matches_are_skipped() {
        let root = temp_root("zero-width");
        fs::write(root.join("f.lua"), "bbb\n").expect("file");

        // `a*` matches the empty string at every position; none should surface.
        let result = find_in_files(&root, "a*", opts(false, false, true)).expect("ok");

        assert!(result.matches.is_empty(), "{:?}", result.matches);
        let _ = fs::remove_dir_all(&root);
    }
}
