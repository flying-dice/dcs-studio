//! Annotation blocks attached to declarations.
//!
//! The contiguous `---` doc run directly above a declaration is shared by
//! two readers: hover (which wants the free-text body) and the type layer
//! (which wants the structured [`AnnotationBlock`]). The run-collection walk
//! lives here so both agree on exactly which lines attach to a declaration.

use dcs_lua_syntax::AnnotationBlock;
use dcs_lua_syntax::span::LineIndex;
use dcs_lua_syntax::token::Trivia;

use crate::workspace::FileEntry;

/// The contiguous doc-comment run ending on the line directly above
/// `decl_line`, in source order, marker already stripped. Empty when no
/// `---` run sits immediately above the declaration.
#[must_use]
pub fn doc_lines(entry: &FileEntry, index: &LineIndex, decl_line: u32) -> Vec<String> {
    let mut by_line: std::collections::HashMap<u32, &str> = std::collections::HashMap::new();
    for spanned in &entry.trivia {
        if let Trivia::DocComment { text } = &spanned.trivia {
            let (line, _) = index.line_col(spanned.span.start);
            by_line.insert(line, text);
        }
    }
    let mut lines: Vec<String> = Vec::new();
    let mut line = decl_line;
    while line > 1 {
        line -= 1;
        let Some(text) = by_line.get(&line) else {
            break;
        };
        lines.push((*text).to_string());
    }
    lines.reverse();
    lines
}

/// The structured annotation block attached to the declaration starting at
/// byte `decl_start`. Empty block when there is no doc run above it.
#[must_use]
pub fn block_at(entry: &FileEntry, decl_start: u32) -> AnnotationBlock {
    let index = LineIndex::new(&entry.source);
    let (decl_line, _) = index.line_col(decl_start);
    let lines = doc_lines(entry, &index, decl_line);
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    dcs_lua_syntax::parse_block(&refs)
}

/// Every doc-comment run in the file, each parsed into a block. A "run" is a
/// maximal set of `---` lines on consecutive source lines. Used by the type
/// table, where `@class`/`@alias`/`@enum` blocks may stand alone in a
/// definition file with no declaration beneath them.
#[must_use]
pub fn all_blocks(entry: &FileEntry) -> Vec<AnnotationBlock> {
    let index = LineIndex::new(&entry.source);
    // Doc-comment lines in source order, paired with their line number.
    let mut docs: Vec<(u32, &str)> = entry
        .trivia
        .iter()
        .filter_map(|spanned| match &spanned.trivia {
            Trivia::DocComment { text } => {
                Some((index.line_col(spanned.span.start).0, text.as_str()))
            }
            _ => None,
        })
        .collect();
    docs.sort_by_key(|(line, _)| *line);

    let mut blocks = Vec::new();
    let mut run: Vec<&str> = Vec::new();
    let mut last_line: Option<u32> = None;
    for (line, text) in docs {
        if last_line.is_some_and(|prev| line != prev + 1) {
            blocks.push(dcs_lua_syntax::parse_block(&run));
            run.clear();
        }
        run.push(text);
        last_line = Some(line);
    }
    if !run.is_empty() {
        blocks.push(dcs_lua_syntax::parse_block(&run));
    }
    blocks
}
