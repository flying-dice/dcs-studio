//! Range formatting (SPEC.md §7): find the smallest run of whole
//! statements enclosing a byte range, format only that run, splice it
//! between byte-identical surroundings.

use dcs_lua_syntax::Span;
use dcs_lua_syntax::ast::{Ast, BlockId, Parsed, StatKind};
use dcs_lua_syntax::token::{SpannedTrivia, Trivia};

use crate::config::FormatConfig;
use crate::printer;

/// Format the statement run enclosing `range`; bytes outside the spliced
/// run are untouched. A range that touches no statement returns the source
/// unchanged.
// All indexing into `stats` is bounds-guarded: `first <= last` (early-returned
// otherwise) and both stay in `0..stats.len()`, with `first > 0` / `last + 1 <
// stats.len()` guards on the neighbour look-ups. `src[..]` slices use byte
// offsets kept <= src.len(). (Totality: the formatter never panics.)
#[allow(clippy::indexing_slicing)]
pub(crate) fn format_range(
    src: &str,
    parsed: &Parsed,
    trivia: &[SpannedTrivia],
    range: Span,
    config: &FormatConfig,
) -> String {
    let range = Span::new(
        range.start.min(src.len() as u32),
        range.end.min(src.len() as u32).max(range.start),
    );
    let (block, depth) = locate(&parsed.ast, parsed.chunk.body, 0, range);
    let stats = &parsed.ast.block(block).stats;

    // Whole statements intersecting the range, widened until the splice
    // start sits at a line boundary owning no earlier statement text and
    // no tail of a straddling comment (a block comment crossing the
    // boundary would otherwise be amputated by the splice).
    let mut first = stats.len();
    let mut last = 0usize;
    for (i, &sid) in stats.iter().enumerate() {
        let span = parsed.ast.stat(sid).span;
        if span.end >= range.start && span.start <= range.end {
            first = first.min(i);
            last = last.max(i);
        }
    }
    if first > last {
        return src.to_string();
    }
    let mut splice_start = line_start(src, parsed.ast.stat(stats[first]).span.start);
    loop {
        let before = (first, splice_start);
        while first > 0 && parsed.ast.stat(stats[first - 1]).span.end > splice_start {
            first -= 1;
            splice_start = line_start(src, parsed.ast.stat(stats[first]).span.start);
        }
        for t in trivia {
            if t.span.start >= splice_start {
                break;
            }
            if t.span.end > splice_start && !matches!(t.trivia, Trivia::BlankLines { .. }) {
                splice_start = line_start(src, t.span.start);
            }
        }
        if (first, splice_start) == before {
            break;
        }
    }

    // Extend the splice over everything riding the last statement's line:
    // a following statement there joins the run (the untouched suffix must
    // never share a line with the formatted text), and same-line comments
    // splice in whole — a straddling block comment moves entirely inside.
    let mut splice_end = parsed.ast.stat(stats[last]).span.end;
    loop {
        let before = (last, splice_end);
        while last + 1 < stats.len() {
            let next = parsed.ast.stat(stats[last + 1]).span.start;
            // A reversed/out-of-bounds range (overlapping recovery spans on a
            // warning-only parse) must not panic — `.get` None ends the
            // coalescing early, which is safe.
            let Some(between) = src.get(splice_end as usize..next as usize) else {
                break;
            };
            if between.contains('\n') {
                break;
            }
            last += 1;
            splice_end = parsed.ast.stat(stats[last]).span.end;
        }
        for t in trivia {
            if t.span.start < splice_end {
                continue;
            }
            // Match the checked sibling above: a reversed range on a warning-only
            // recovery parse must not panic — an invalid range is treated as
            // "not same line" so the trivia merge stops safely.
            let same_line = src
                .get(splice_end as usize..t.span.start as usize)
                .is_some_and(|s| !s.contains('\n'));
            if same_line && !matches!(t.trivia, Trivia::BlankLines { .. }) {
                splice_end = t.span.end;
            } else {
                break;
            }
        }
        if (last, splice_end) == before {
            break;
        }
    }

    // The run's first statement needs no `;` merge guard when it starts
    // its block — or when the untouched prefix already ends with a `;`
    // separator (between the previous statement and the splice start only
    // separators, whitespace, and comments can sit): doubling it would
    // print `;;`, which PUC Lua 5.1 rejects and the tolerant in-house
    // re-parse cannot catch.
    let first_separated = first == 0
        || semi_separates(
            src,
            trivia,
            parsed.ast.stat(stats[first - 1]).span.end,
            splice_start,
        );
    let run = &stats[first..=last];
    let formatted = printer::print_run(
        src,
        parsed,
        trivia,
        config,
        run,
        depth,
        splice_start,
        first_separated,
    );
    let mut out = String::with_capacity(src.len() + 64);
    out.push_str(&src[..splice_start as usize]);
    out.push_str(&formatted);
    out.push_str(&src[splice_end as usize..]);
    out
}

/// Whether a real `;` statement separator (a `;` byte outside any
/// comment) sits in `src[from..to)`.
fn semi_separates(src: &str, trivia: &[SpannedTrivia], from: u32, to: u32) -> bool {
    src.get(from as usize..to as usize)
        .unwrap_or("")
        .bytes()
        .enumerate()
        .any(|(i, byte)| {
            byte == b';' && {
                let pos = from + u32::try_from(i).unwrap_or(u32::MAX);
                !trivia
                    .iter()
                    .any(|t| t.span.start <= pos && pos < t.span.end)
            }
        })
}

/// Offset of the start of the line containing `offset`.
fn line_start(src: &str, offset: u32) -> u32 {
    src[..offset as usize]
        .rfind('\n')
        .map_or(0, |i| (i + 1) as u32)
}

/// The deepest statement-reachable block whose span contains the range,
/// with its indent depth. Blocks nested inside expression-level function
/// literals are not descended — their printed indent is not statically a
/// block depth — so a range there widens to its enclosing statement.
fn locate(ast: &Ast, block: BlockId, depth: usize, range: Span) -> (BlockId, usize) {
    for &sid in &ast.block(block).stats {
        let stat = ast.stat(sid);
        if !(stat.span.start <= range.start && range.end <= stat.span.end) {
            continue;
        }
        for child in stat_blocks(&stat.kind) {
            let child_span = ast.block(child).span;
            if child_span.start <= range.start && range.end <= child_span.end {
                return locate(ast, child, depth + 1, range);
            }
        }
        return (block, depth);
    }
    (block, depth)
}

/// The blocks a statement owns directly (function-declaration bodies
/// included; expression-level literals excluded).
fn stat_blocks(kind: &StatKind) -> Vec<BlockId> {
    match kind {
        StatKind::Do { body }
        | StatKind::While { body, .. }
        | StatKind::Repeat { body, .. }
        | StatKind::NumericFor { body, .. }
        | StatKind::GenericFor { body, .. } => vec![*body],
        StatKind::If { arms, else_body } => {
            let mut blocks: Vec<BlockId> = arms.iter().map(|arm| arm.body).collect();
            blocks.extend(else_body);
            blocks
        }
        StatKind::FunctionDecl { func, .. } | StatKind::LocalFunction { func, .. } => {
            vec![func.body]
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::line_start;

    #[test]
    fn line_start_finds_boundaries() {
        let src = "a\nbb\nccc";
        assert_eq!(line_start(src, 0), 0);
        assert_eq!(line_start(src, 3), 2);
        assert_eq!(line_start(src, 7), 5);
    }
}
