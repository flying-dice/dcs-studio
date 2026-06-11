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
    // start sits at a line boundary owning no earlier statement text.
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
    while first > 0 && parsed.ast.stat(stats[first - 1]).span.end > splice_start {
        first -= 1;
        splice_start = line_start(src, parsed.ast.stat(stats[first]).span.start);
    }

    // Extend the splice over comments riding the last statement's line.
    let mut splice_end = parsed.ast.stat(stats[last]).span.end;
    for t in trivia {
        if t.span.start < splice_end {
            continue;
        }
        let same_line = !src[splice_end as usize..t.span.start as usize].contains('\n');
        if same_line && !matches!(t.trivia, Trivia::BlankLines { .. }) {
            splice_end = t.span.end;
        } else {
            break;
        }
    }

    let run = &stats[first..=last];
    let formatted = printer::print_run(src, parsed, trivia, config, run, depth, splice_start);
    let mut out = String::with_capacity(src.len() + 64);
    out.push_str(&src[..splice_start as usize]);
    out.push_str(&formatted);
    out.push_str(&src[splice_end as usize..]);
    out
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
