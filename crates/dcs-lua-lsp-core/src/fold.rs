//! `textDocument/foldingRange`: foldable regions of one file.
//!
//! Every block-carrying statement, function literal, table constructor,
//! and long comment folds. Ranges are byte spans; the editor folds by line
//! and drops single-line ranges itself.

use dcs_lua_syntax::ast::{ExprKind, StatKind};
use dcs_lua_syntax::span::Span;
use dcs_lua_syntax::token::Trivia;

use crate::workspace::Workspace;

/// The foldable spans of `path`; empty when the file is not mounted.
#[must_use]
pub fn folding_ranges(workspace: &Workspace, path: &str) -> Vec<Span> {
    let Some(entry) = workspace.file(path) else {
        return Vec::new();
    };
    let ast = &entry.parsed.ast;
    let mut ranges = Vec::new();
    for stat in &ast.stats {
        if matches!(
            stat.kind,
            StatKind::Do { .. }
                | StatKind::While { .. }
                | StatKind::Repeat { .. }
                | StatKind::If { .. }
                | StatKind::NumericFor { .. }
                | StatKind::GenericFor { .. }
                | StatKind::FunctionDecl { .. }
                | StatKind::LocalFunction { .. }
        ) {
            ranges.push(stat.span);
        }
    }
    for expr in &ast.exprs {
        match &expr.kind {
            ExprKind::Function(func) => ranges.push(func.span),
            ExprKind::Table { .. } => ranges.push(expr.span),
            _ => {}
        }
    }
    for trivia in &entry.trivia {
        if matches!(trivia.trivia, Trivia::LongComment { .. }) {
            ranges.push(trivia.span);
        }
    }
    ranges.sort_by_key(|span| (span.start, std::cmp::Reverse(span.end)));
    ranges
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_functions_tables_and_long_comments_fold() {
        let mut ws = Workspace::new();
        ws.set_source(
            "f.lua",
            "--[[\nheader\n]]\nfunction f()\n  if x then\n  end\nend\nt = {\n  1,\n}",
        );
        let ranges = folding_ranges(&ws, "f.lua");
        // long comment, function, if, table
        assert!(ranges.len() >= 4);
        let first = ranges[0];
        assert_eq!(first.start, 0); // the long comment leads the file
    }
}
