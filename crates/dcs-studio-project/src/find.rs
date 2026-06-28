//! Project-wide find-in-files behind the IDE's floating search overlay
//! (model: `studio::search::FindInFiles`, issue #68).
//!
//! The walk mirrors the [`crate::todos`] scanner: the `ignore` crate's
//! gitignore-aware [`WalkBuilder`] (`.gitignore`, hidden files, and `.git`
//! filtered even outside a git repo), files over [`crate::todos::MAX_FILE_BYTES`]
//! skipped, and non-UTF-8 (binary) files skipped. A search never fails on the
//! filesystem — an unreadable file simply contributes nothing; the only error
//! is a malformed regex (regex mode), which the caller surfaces as an inline
//! hint rather than a crash.
//!
//! Matching is literal or regex, with case-sensitive and whole-word options;
//! every mode compiles to one [`Regex`] so the per-line loop is uniform.
//! Results are returned in path-then-line order and capped at [`MATCH_CAP`]:
//! reaching the cap stops the walk and flags the outcome truncated, so a
//! runaway query bounds memory and render cost instead of silently dropping
//! the overflow.
//!
//! v1 searches files on disk — unsaved editor buffers are not reflected.

use std::path::Path;

use ignore::WalkBuilder;
use regex::{Regex, RegexBuilder};

use crate::todos::MAX_FILE_BYTES;

/// The hard cap on matches a single search returns (model
/// `studio::search::SEARCH_MATCH_CAP`). Reaching it stops the walk and flags
/// the outcome [`SearchOutcome::truncated`].
pub const MATCH_CAP: usize = 2000;

/// A matched line is stored clipped to this many UTF-16 code units, so a
/// minified single-line file cannot blow memory through repeated matches. The
/// match's `column`/`length` stay true to the file regardless, so the editor
/// caret still lands exactly on the match even when the preview is clipped.
pub const MAX_LINE_UTF16: usize = 1000;

/// A query and its match options (model `studio::search::SearchQuery`).
/// Deserialized from the frontend's camelCase payload.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    /// The text typed by the developer — literal text, or a regex pattern when
    /// `regex` is set.
    pub query: String,
    /// Match case exactly. When false (the default) matching is
    /// case-insensitive.
    pub case_sensitive: bool,
    /// Match only whole words — the query is bounded by word boundaries on
    /// both sides.
    pub whole_word: bool,
    /// Treat `query` as a regular expression rather than literal text.
    pub regex: bool,
}

/// One match (model `studio::search::SearchMatch`). `line` is 1-based;
/// `column` is the 1-based UTF-16 start column (the editor caret's coordinate);
/// `length` is the match's UTF-16 length (the highlight span); `text` is the
/// matched line (clipped to [`MAX_LINE_UTF16`]).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SearchMatch {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub length: u32,
    pub text: String,
}

/// A completed search (model `studio::search::SearchOutcome`): matches in
/// path-then-line order, and whether the cap clipped the result set.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SearchOutcome {
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
}

/// Why a search could not run (model `studio::search::SearchError`): only a
/// malformed regex in regex mode — the literal matcher never fails.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SearchError {
    pub message: String,
}

/// Search every non-ignored file under `root` for `query`, returning matches
/// in path-then-line order (capped at [`MATCH_CAP`]). The only error is a
/// malformed regex; filesystem failures are absorbed (the file contributes
/// nothing).
///
/// # Errors
/// Returns [`SearchError`] when `query` is a malformed regex in regex mode.
pub fn search(root: &Path, query: &SearchQuery) -> Result<SearchOutcome, SearchError> {
    let re = build_matcher(query)?;
    let mut matches = Vec::new();
    let mut truncated = false;

    let walker = WalkBuilder::new(root)
        // Respect .gitignore even when the workspace is not a git repo
        // (fresh projects, test fixtures) — the TodoScanner rule.
        .require_git(false)
        .build();
    'walk: for dent in walker.flatten() {
        if !dent.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Some(text) = read_text(dent.path()) else {
            continue;
        };
        let path = dent.path().to_string_lossy();
        for (line_idx, line) in text.lines().enumerate() {
            if push_line_matches(&path, line_idx, line, &re, &mut matches, MATCH_CAP) {
                truncated = true;
                break 'walk;
            }
        }
    }

    matches.sort_by(|a, b| {
        a.path
            .cmp(&b.path)
            .then(a.line.cmp(&b.line))
            .then(a.column.cmp(&b.column))
    });
    Ok(SearchOutcome { matches, truncated })
}

/// Append every non-empty match on one line to `out`, stopping early once
/// `out` reaches `cap`; returns whether the cap was hit (the caller then stops
/// the walk and flags the outcome truncated). The per-line core shared by
/// [`search`] and its tests, so the column/length/clip math has one home.
fn push_line_matches(
    path: &str,
    line_idx: usize,
    line: &str,
    re: &Regex,
    out: &mut Vec<SearchMatch>,
    cap: usize,
) -> bool {
    for m in re.find_iter(line) {
        // Empty matches (e.g. `a*` against "bbb") carry no span to highlight
        // or jump to — skip them rather than emit noise.
        if m.start() == m.end() {
            continue;
        }
        if out.len() >= cap {
            return true;
        }
        out.push(SearchMatch {
            path: path.to_string(),
            line: u32::try_from(line_idx + 1).unwrap_or(u32::MAX),
            column: utf16_len(&line[..m.start()]) + 1,
            length: utf16_len(m.as_str()),
            text: clip_line(line),
        });
    }
    false
}

/// Compile the query and its options into one regex. Literal queries are
/// escaped; whole-word wraps the pattern in `\b…\b` (a non-capturing group so
/// alternations in regex mode stay intact); case-insensitive is the default.
fn build_matcher(query: &SearchQuery) -> Result<Regex, SearchError> {
    let core = if query.regex {
        query.query.clone()
    } else {
        regex::escape(&query.query)
    };
    let pattern = if query.whole_word {
        format!(r"\b(?:{core})\b")
    } else {
        core
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!query.case_sensitive)
        .build()
        .map_err(|e| SearchError {
            message: e.to_string(),
        })
}

/// Read a file as UTF-8 text, or `None` when it is missing, oversized
/// (> [`MAX_FILE_BYTES`]), non-UTF-8, or otherwise unreadable — the
/// `TodoScanner`'s fail-soft rule.
fn read_text(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    String::from_utf8(bytes).ok()
}

/// Clip a line to [`MAX_LINE_UTF16`] code units for the stored preview, on a
/// char boundary. The match's column/length index the original line, so the
/// caret jump stays exact even when the preview is clipped.
fn clip_line(line: &str) -> String {
    let mut out = String::new();
    let mut units = 0usize;
    for c in line.chars() {
        let w = c.len_utf16();
        if units + w > MAX_LINE_UTF16 {
            break;
        }
        out.push(c);
        units += w;
    }
    out
}

/// UTF-16 code-unit length of `s` — the editor caret's coordinate system, so a
/// jump lands on the match even after multibyte text.
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

    fn query(text: &str) -> SearchQuery {
        SearchQuery {
            query: text.to_string(),
            case_sensitive: false,
            whole_word: false,
            regex: false,
        }
    }

    /// Run the real per-line core over in-memory text, uncapped — so the tests
    /// exercise [`push_line_matches`] itself, not a copy of its math.
    fn matches_in(text: &str, q: &SearchQuery) -> Vec<SearchMatch> {
        let re = build_matcher(q).expect("valid pattern");
        let mut out = Vec::new();
        for (line_idx, line) in text.lines().enumerate() {
            push_line_matches("x", line_idx, line, &re, &mut out, usize::MAX);
        }
        out
    }

    #[test]
    fn walks_nested_dirs_sorted_by_path_then_line() {
        let root = temp_root("nested");
        fs::create_dir_all(root.join("sub")).expect("dirs");
        fs::write(root.join("sub/b.lua"), "print(1)\nlocal gauge = 2\n").expect("file");
        fs::write(root.join("a.lua"), "local gauge = 1\nprint(gauge)\n").expect("file");

        let out = search(&root, &query("gauge")).expect("search");

        assert!(!out.truncated);
        let rows: Vec<_> = out
            .matches
            .iter()
            .map(|m| (m.path.ends_with("a.lua"), m.line, m.column, m.length))
            .collect();
        // a.lua (line 1 col 7, line 2 col 7) sorts before sub/b.lua (line 2 col 7).
        assert_eq!(
            rows,
            vec![(true, 1, 7, 5), (true, 2, 7, 5), (false, 2, 7, 5)],
            "{:?}",
            out.matches
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn multiple_matches_on_one_line_each_surface() {
        let out = matches_in("foo foo foo\n", &query("foo"));
        assert_eq!(out.len(), 3, "{out:?}");
        assert_eq!(
            out.iter().map(|m| m.column).collect::<Vec<_>>(),
            vec![1, 5, 9]
        );
    }

    #[test]
    fn case_insensitive_by_default_sensitive_on_request() {
        assert_eq!(matches_in("Gauge gauge GAUGE\n", &query("gauge")).len(), 3);

        let mut q = query("gauge");
        q.case_sensitive = true;
        let out = matches_in("Gauge gauge GAUGE\n", &q);
        assert_eq!(out.len(), 1, "{out:?}");
        assert_eq!(out[0].column, 7);
    }

    #[test]
    fn whole_word_bounds_the_match() {
        let mut q = query("gauge");
        q.whole_word = true;
        // "gauges" and "mygauge" are embedded; only the bounded "gauge" matches.
        let out = matches_in("gauges mygauge gauge\n", &q);
        assert_eq!(out.len(), 1, "{out:?}");
        assert_eq!(out[0].column, 16);
    }

    #[test]
    fn regex_mode_matches_patterns_literal_mode_does_not() {
        let mut q = query(r"g\w+e");
        q.regex = true;
        let out = matches_in("gauge gizmo\n", &q);
        assert_eq!(out.len(), 1, "{out:?}");
        assert_eq!(out[0].length, 5);

        // The same text as a literal query finds nothing — the backslash is escaped.
        assert!(matches_in("gauge gizmo\n", &query(r"g\w+e")).is_empty());
    }

    #[test]
    fn whole_word_composes_with_regex_alternation() {
        let mut q = query("foo|bar");
        q.regex = true;
        q.whole_word = true;
        // The non-capturing wrap keeps the alternation intact: both whole
        // words match, the embedded "foobar" does not.
        let out = matches_in("foo bar foobar\n", &q);
        assert_eq!(out.len(), 2, "{out:?}");
        assert_eq!(
            out.iter().map(|m| m.column).collect::<Vec<_>>(),
            vec![1, 5]
        );
    }

    #[test]
    fn invalid_regex_is_an_error_not_a_panic() {
        let mut q = query("(unclosed");
        q.regex = true;
        let err = search(&temp_root("bad-re"), &q).expect_err("invalid pattern");
        assert!(!err.message.is_empty());
    }

    #[test]
    fn empty_pattern_matches_yield_no_rows() {
        // `a*` matches empty between every non-'a' char; those carry no span.
        let mut q = query("a*");
        q.regex = true;
        let out = matches_in("xax\n", &q);
        assert_eq!(out.len(), 1, "only the real 'a' span, no empties: {out:?}");
        assert_eq!((out[0].column, out[0].length), (2, 1));
    }

    #[test]
    fn gitignored_files_are_excluded() {
        let root = temp_root("gitignore");
        fs::create_dir_all(root.join("gen")).expect("dirs");
        fs::write(root.join(".gitignore"), "gen/\n").expect("gitignore");
        fs::write(root.join("gen/skip.lua"), "local gauge = 0\n").expect("ignored");
        fs::write(root.join("keep.lua"), "local gauge = 1\n").expect("kept");

        let out = search(&root, &query("gauge")).expect("search");

        assert_eq!(out.matches.len(), 1, "{:?}", out.matches);
        assert!(out.matches[0].path.ends_with("keep.lua"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn files_over_the_size_cap_are_skipped() {
        let root = temp_root("size-cap");
        let mut big = String::from("local gauge = 1\n");
        big.push_str(&"x".repeat(usize::try_from(MAX_FILE_BYTES).expect("usize") + 1));
        fs::write(root.join("big.lua"), big).expect("big file");
        fs::write(root.join("small.lua"), "local gauge = 2\n").expect("small file");

        let out = search(&root, &query("gauge")).expect("search");

        assert_eq!(out.matches.len(), 1, "{:?}", out.matches);
        assert!(out.matches[0].path.ends_with("small.lua"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn non_utf8_files_are_skipped_gracefully() {
        let root = temp_root("binary");
        // Bytes spelling "gauge" then an invalid UTF-8 tail.
        fs::write(root.join("blob.bin"), [b'g', b'a', b'u', b'g', b'e', 0xff]).expect("binary");

        let out = search(&root, &query("gauge")).expect("search");

        assert!(out.matches.is_empty(), "{:?}", out.matches);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn results_cap_truncates_without_silent_loss() {
        let root = temp_root("cap");
        // One match per line, MATCH_CAP + 50 lines.
        let body = "gauge\n".repeat(MATCH_CAP + 50);
        fs::write(root.join("many.lua"), body).expect("file");

        let out = search(&root, &query("gauge")).expect("search");

        assert_eq!(out.matches.len(), MATCH_CAP);
        assert!(out.truncated, "the overflow is flagged, not dropped silently");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn column_counts_utf16_code_units_not_bytes() {
        // The multibyte prefix makes byte and UTF-16 offsets diverge: the
        // editor caret (UTF-16) only lands on the match if columns count
        // UTF-16 code units.
        let line = "-- наводка gauge\n";
        let out = matches_in(line, &query("gauge"));
        assert_eq!(out.len(), 1);
        let expected = u32::try_from(
            line[..line.find("gauge").expect("present")]
                .encode_utf16()
                .count(),
        )
        .expect("fits")
            + 1;
        assert_eq!(out[0].column, expected);
        assert_ne!(
            u64::from(out[0].column),
            line.find("gauge").expect("present") as u64 + 1,
            "the fixture really discriminates bytes from UTF-16"
        );
    }

    #[test]
    fn long_line_preview_is_clipped_but_column_stays_true() {
        let mut line = "x".repeat(MAX_LINE_UTF16 + 100);
        line.push_str("gauge");
        let out = matches_in(&format!("{line}\n"), &query("gauge"));
        assert_eq!(out.len(), 1);
        // The preview is clipped to the cap…
        assert_eq!(out[0].text.encode_utf16().count(), MAX_LINE_UTF16);
        // …but the column still points past the clip, into the real file.
        assert_eq!(out[0].column, u32::try_from(MAX_LINE_UTF16 + 100).unwrap() + 1);
    }

    #[test]
    fn no_matches_is_empty_not_an_error() {
        let root = temp_root("none");
        fs::write(root.join("a.lua"), "print(1)\n").expect("file");
        let out = search(&root, &query("nonexistent")).expect("search");
        assert!(out.matches.is_empty());
        assert!(!out.truncated);
        let _ = fs::remove_dir_all(&root);
    }
}
