//! `textDocument/references`: every use of the symbol under the cursor
//! across the mounted workspace, the declaration included.
//!
//! Scope-awareness falls out of reusing the resolver: a candidate occurrence
//! is a reference iff it resolves to the SAME declaration as the cursor does.
//! A declaration's identity is `(declaring file, name-span start)` — unique
//! per declaration, so two same-named locals in sibling scopes, or `lib.f`
//! and `other.f`, never merge. Locals stay in their file because the resolver
//! never escapes a lexical scope; globals span files because the resolver's
//! workspace-global lookup does.

use dcs_lua_syntax::ast::{ExprKind, Parsed, StatKind};
use dcs_lua_syntax::span::Span;

use crate::definition::{Location, resolved_name};
use crate::workspace::Workspace;

/// Every reference to the symbol at `offset` in `path`, ordered by file then
/// offset, the declaration included. Empty when the offset resolves to
/// nothing.
#[must_use]
pub fn references(workspace: &Workspace, path: &str, offset: u32) -> Vec<Location> {
    let Some((target_path, target_span)) = resolved_name(workspace, path, offset) else {
        return Vec::new();
    };
    let target = (target_path.as_str(), target_span.start);

    let mut out: Vec<Location> = Vec::new();
    for (file, entry) in workspace.files() {
        for span in occurrence_spans(&entry.parsed) {
            // Re-resolve the candidate at its own start: a reference is an
            // occurrence binding to the same declaration as the cursor.
            if let Some((decl_path, decl_span)) = resolved_name(workspace, file, span.start)
                && (decl_path.as_str(), decl_span.start) == target
            {
                out.push(Location {
                    path: file.to_string(),
                    span,
                });
            }
        }
    }
    out.sort_by(|a, b| (a.path.as_str(), a.span.start).cmp(&(b.path.as_str(), b.span.start)));
    out.dedup();
    out
}

/// The span of every identifier occurrence in a file: declaration names
/// (locals, parameters, `for` bindings, the renameable tail of a function
/// declaration) and use sites (`NameRef` reads, `obj.field` field names). An
/// occurrence is recorded once; whether it is a reference to a given symbol
/// is decided by re-resolving it.
fn occurrence_spans(parsed: &Parsed) -> Vec<Span> {
    let ast = &parsed.ast;
    let mut spans: Vec<Span> = Vec::new();

    for stat in &ast.stats {
        match &stat.kind {
            StatKind::LocalAssign { names, .. } => {
                spans.extend(names.iter().map(|name| name.span));
            }
            StatKind::LocalFunction { name, func } => {
                spans.push(name.span);
                spans.extend(func.params.iter().map(|p| p.span));
            }
            StatKind::FunctionDecl { name, func } => {
                // Only the renameable tail — the method name, else the final
                // dotted segment. Leading segments are table references, a
                // different symbol resolved on their own.
                if let Some(method) = &name.method {
                    spans.push(method.span);
                } else if let Some(last) = name.segments.last() {
                    spans.push(last.span);
                }
                spans.extend(func.params.iter().map(|p| p.span));
            }
            StatKind::NumericFor { name, .. } => spans.push(name.span),
            StatKind::GenericFor { names, .. } => {
                spans.extend(names.iter().map(|name| name.span));
            }
            _ => {}
        }
    }

    for expr in &ast.exprs {
        match &expr.kind {
            ExprKind::NameRef(_) => spans.push(expr.span),
            ExprKind::Field { name, .. } => spans.push(name.span),
            ExprKind::Function(func) => {
                spans.extend(func.params.iter().map(|p| p.span));
            }
            _ => {}
        }
    }

    spans
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(src: &str, needle: &str, nth: usize) -> u32 {
        src.match_indices(needle).nth(nth).expect("needle").0 as u32
    }

    #[test]
    fn references_collect_declaration_and_every_use() {
        let mut ws = Workspace::new();
        let src = "local val = 1\nreturn val + val\n";
        ws.set_source("m.lua", src);
        // Querying any occurrence yields all three: the declaration plus two
        // uses.
        let refs = references(&ws, "m.lua", at(src, "val", 2));
        let starts: Vec<u32> = refs.iter().map(|r| r.span.start).collect();
        assert_eq!(
            starts,
            vec![at(src, "val", 0), at(src, "val", 1), at(src, "val", 2)]
        );
    }

    #[test]
    fn references_keep_same_named_locals_in_separate_scopes_apart() {
        let mut ws = Workspace::new();
        // Two `s` locals in sibling blocks: a reference query on one must not
        // bleed into the other (4 occurrences total, 2 per scope).
        let src = "do local s = 1\nprint(s) end\ndo local s = 2\nprint(s) end\n";
        ws.set_source("m.lua", src);
        let refs = references(&ws, "m.lua", at(src, "s = 1", 0));
        assert_eq!(refs.len(), 2, "{refs:?}");
        let starts: Vec<u32> = refs.iter().map(|r| r.span.start).collect();
        // Only the first scope's declaration and use.
        assert_eq!(starts, vec![at(src, "s = 1", 0), at(src, "s)", 0)]);
    }

    #[test]
    fn references_span_files_for_a_global() {
        let mut ws = Workspace::new();
        ws.set_source("lib.lua", "function shared()\nend\n");
        ws.set_source("a.lua", "shared()\n");
        ws.set_source("b.lua", "shared()\n");
        let refs = references(&ws, "a.lua", at("shared()\n", "shared", 0));
        // Declaration in lib.lua plus one use in each of a.lua and b.lua.
        let files: Vec<&str> = refs.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(files, vec!["a.lua", "b.lua", "lib.lua"]);
    }

    #[test]
    fn references_empty_when_offset_resolves_to_nothing() {
        let mut ws = Workspace::new();
        let src = "local x = 1\n";
        ws.set_source("m.lua", src);
        assert!(references(&ws, "m.lua", at(src, "=", 0)).is_empty());
    }
}
