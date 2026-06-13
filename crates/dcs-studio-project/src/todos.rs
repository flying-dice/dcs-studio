//! Workspace comment-tag scanner behind the IDE's Todos panel
//! (model: `studio::todos::TodoScanner`, issue #16).
//!
//! Matching rule (deliberately simple — documented, not over-engineered):
//! a tag matches **case-sensitively** anywhere in a line when it is bounded
//! by non-word characters on both sides (start/end of line count as
//! boundaries; word characters are `[A-Za-z0-9_]`). At most one entry per
//! line — the earliest bounded occurrence of any tag wins. This surfaces
//! `-- TODO: x`, `// FIXME(bob): y`, `# HACK y`, and the repo's
//! `TODO: clean-code - <score> - <CAT>: …` skill markers, while `myTODO`
//! or `TODOS` never match.
//!
//! The workspace walk is gitignore-aware (the `ignore` crate's standard
//! filters: `.gitignore`, hidden files, `.git` — so `node_modules/` and
//! `target/` are skipped wherever they are ignored). Files over
//! [`MAX_FILE_BYTES`] and non-UTF-8 (binary) files are skipped gracefully;
//! a scan never fails — unreadable files simply contribute no entries.

use std::path::Path;

use ignore::WalkBuilder;

/// The default tag set; the repo's `TODO: clean-code` markers surface via
/// `TODO`.
pub const DEFAULT_TAGS: &[&str] = &["TODO", "FIXME", "HACK", "XXX"];

/// Files larger than this are skipped (generated blobs, vendored bundles).
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// One comment-tag hit. `line` and `column` are 1-based; `column` counts
/// UTF-16 code units (the editor's caret coordinates), so a jump lands
/// exactly on the tag even after multibyte text. `text` is the line's
/// content after the tag, with leading `:`/whitespace separators trimmed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TodoEntry {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub tag: String,
    pub text: String,
}

/// Scan every non-ignored file under `root`, sorted by path then line.
#[must_use]
pub fn scan<S: AsRef<str>>(root: &Path, tags: &[S]) -> Vec<TodoEntry> {
    let mut entries = Vec::new();
    let walker = WalkBuilder::new(root)
        // Respect .gitignore even when the workspace is not a git repo
        // (fresh projects, test fixtures).
        .require_git(false)
        .build();
    for dent in walker.flatten() {
        if !dent.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        entries.extend(scan_file(dent.path(), tags));
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    entries
}

/// Scan one file. Oversized (> [`MAX_FILE_BYTES`]), non-UTF-8, or
/// unreadable files yield no entries — never an error.
#[must_use]
pub fn scan_file<S: AsRef<str>>(path: &Path, tags: &[S]) -> Vec<TodoEntry> {
    let Ok(meta) = std::fs::metadata(path) else {
        return Vec::new();
    };
    if meta.len() > MAX_FILE_BYTES {
        return Vec::new();
    }
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    let Ok(text) = String::from_utf8(bytes) else {
        return Vec::new();
    };
    scan_text(&path.to_string_lossy(), &text, tags)
}

/// Apply the matching rule to in-memory text (the testable core).
fn scan_text<S: AsRef<str>>(path: &str, text: &str, tags: &[S]) -> Vec<TodoEntry> {
    let mut entries = Vec::new();
    for (line_idx, line) in text.lines().enumerate() {
        if let Some((start, tag)) = earliest_tag(line, tags) {
            entries.push(TodoEntry {
                path: path.to_string(),
                line: u32::try_from(line_idx + 1).unwrap_or(u32::MAX),
                column: utf16_len(&line[..start]) + 1,
                tag: tag.to_string(),
                text: trim_separators(&line[start + tag.len()..]),
            });
        }
    }
    entries
}

/// The earliest word-bounded occurrence of any tag in `line`, if any.
fn earliest_tag<'t, S: AsRef<str>>(line: &str, tags: &'t [S]) -> Option<(usize, &'t str)> {
    let mut best: Option<(usize, &'t str)> = None;
    for tag in tags {
        let tag = tag.as_ref();
        if tag.is_empty() {
            continue;
        }
        let mut from = 0;
        while let Some(found) = line[from..].find(tag) {
            let start = from + found;
            if bounded(line, start, tag.len()) {
                if best.is_none_or(|(s, _)| start < s) {
                    best = Some((start, tag));
                }
                break;
            }
            from = start + tag.len();
        }
    }
    best
}

/// Word boundary on both sides: the byte before `start` and the byte after
/// the match must not be word characters (`[A-Za-z0-9_]`); the line's ends
/// count as boundaries.
fn bounded(line: &str, start: usize, len: usize) -> bool {
    let before = line[..start].chars().next_back();
    let after = line[start + len..].chars().next();
    !before.is_some_and(is_word) && !after.is_some_and(is_word)
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Row label: the remainder after the tag, minus leading `:` / whitespace.
fn trim_separators(rest: &str) -> String {
    rest.trim_start_matches([':', ' ', '\t'])
        .trim_end()
        .to_string()
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
        let dir = std::env::temp_dir().join(format!("dcs-todos-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn scan_walks_nested_dirs_and_sorts_by_path_then_line() {
        let root = temp_root("nested");
        fs::create_dir_all(root.join("sub/deeper")).expect("dirs");
        fs::write(
            root.join("sub/deeper/b.lua"),
            "print(1)\n-- TODO: deep entry\n",
        )
        .expect("file");
        fs::write(
            root.join("a.lua"),
            "-- FIXME: first\nprint(2)\n-- HACK trailing note \n",
        )
        .expect("file");

        let entries = scan(&root, DEFAULT_TAGS);

        assert_eq!(entries.len(), 3, "all nested entries surface: {entries:?}");
        assert_eq!(entries[0].tag, "FIXME");
        assert_eq!(entries[0].line, 1);
        assert_eq!(entries[0].column, 4, "1-based column of the tag itself");
        assert_eq!(entries[0].text, "first");
        assert_eq!(entries[1].tag, "HACK");
        assert_eq!(entries[1].line, 3);
        assert_eq!(entries[1].text, "trailing note", "trailing space trimmed");
        assert_eq!(entries[2].tag, "TODO");
        assert!(
            entries[2].path.ends_with("b.lua"),
            "sorted by path then line: {entries:?}"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn gitignored_files_are_excluded() {
        let root = temp_root("gitignore");
        fs::create_dir_all(root.join("generated")).expect("dirs");
        fs::write(root.join(".gitignore"), "generated/\n").expect("gitignore");
        fs::write(
            root.join("generated/big.lua"),
            "-- TODO: must not surface\n",
        )
        .expect("ignored file");
        fs::write(root.join("kept.lua"), "-- TODO: kept entry\n").expect("kept file");

        let entries = scan(&root, DEFAULT_TAGS);

        assert_eq!(entries.len(), 1, "only the non-ignored file: {entries:?}");
        assert!(entries[0].path.ends_with("kept.lua"));
        assert_eq!(entries[0].text, "kept entry");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn files_over_the_size_cap_are_skipped() {
        let root = temp_root("size-cap");
        let mut big = String::from("-- TODO: hidden by the cap\n");
        big.push_str(&"x".repeat(usize::try_from(MAX_FILE_BYTES).expect("usize") + 1));
        fs::write(root.join("big.lua"), big).expect("big file");
        fs::write(root.join("small.lua"), "-- TODO: small enough\n").expect("small file");

        let entries = scan(&root, DEFAULT_TAGS);

        assert_eq!(entries.len(), 1, "the oversized file is skipped: {entries:?}");
        assert!(entries[0].path.ends_with("small.lua"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn non_utf8_files_are_skipped_gracefully() {
        let root = temp_root("binary");
        fs::write(root.join("blob.bin"), [0x54, 0x4f, 0x44, 0x4f, 0xff, 0xfe]).expect("binary");

        let entries = scan(&root, DEFAULT_TAGS);

        assert!(entries.is_empty(), "binary contributes nothing: {entries:?}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn clean_code_skill_marker_shape_surfaces() {
        let root = temp_root("clean-code");
        fs::write(
            root.join("svc.rs"),
            "// TODO: clean-code - 0.7 - DRY: extract the shared walker\n",
        )
        .expect("file");

        let entries = scan(&root, DEFAULT_TAGS);

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].tag, "TODO");
        assert_eq!(
            entries[0].text, "clean-code - 0.7 - DRY: extract the shared walker",
            "the marker's score and category survive into the row text"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn tags_match_only_at_word_boundaries_and_case_sensitively() {
        let entries = scan_text(
            "x.lua",
            concat!(
                "local myTODO = 1\n",     // embedded: no match
                "-- TODOS for later\n",   // suffix word char: no match
                "-- todo: lowercase\n",   // case-sensitive: no match
                "-- TODO(bob): tagged\n", // '(' bounds: match
                "exit() -- XXX\n",        // end of line bounds: match
            ),
            DEFAULT_TAGS,
        );
        assert_eq!(
            entries
                .iter()
                .map(|e| (e.line, e.tag.as_str()))
                .collect::<Vec<_>>(),
            vec![(4, "TODO"), (5, "XXX")],
            "{entries:?}"
        );
        assert_eq!(entries[0].text, "(bob): tagged");
        assert_eq!(entries[1].text, "");
    }

    #[test]
    fn earliest_tag_wins_one_entry_per_line() {
        let entries = scan_text("x.lua", "-- FIXME then TODO later\n", DEFAULT_TAGS);
        assert_eq!(entries.len(), 1, "one entry per line: {entries:?}");
        assert_eq!(entries[0].tag, "FIXME", "earliest occurrence wins");
    }

    #[test]
    fn column_counts_utf16_code_units_not_bytes() {
        // The multibyte prefix makes byte and UTF-16 offsets diverge: the
        // editor caret (UTF-16) only lands on the tag if columns count
        // UTF-16 code units.
        let line = "-- наводка TODO: localized\n";
        let entries = scan_text("x.lua", line, DEFAULT_TAGS);
        assert_eq!(entries.len(), 1);
        let expected = u32::try_from(
            line[..line.find("TODO").expect("tag present")]
                .encode_utf16()
                .count(),
        )
        .expect("fits")
            + 1;
        assert_eq!(entries[0].column, expected);
        assert_ne!(
            u64::from(entries[0].column),
            line.find("TODO").expect("tag present") as u64 + 1,
            "the fixture really discriminates bytes from UTF-16"
        );
    }

    #[test]
    fn scan_file_on_missing_path_is_empty() {
        let root = temp_root("missing");
        let entries = scan_file(&root.join("nope.lua"), DEFAULT_TAGS);
        assert!(entries.is_empty());
        let _ = fs::remove_dir_all(&root);
    }
}
