//! `textDocument/documentSymbol`: the declaration outline of one file.

use dcs_lua_syntax::ast::{Ast, BlockId, ExprKind, FuncBody, FuncName, StatKind};
use dcs_lua_syntax::span::Span;
use serde::Serialize;

use crate::workspace::Workspace;

/// The outline entry classes Phase 1 distinguishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum SymbolKind {
    Function,
    Variable,
}

/// One outline entry; `selection` is the name, `span` the whole
/// declaration. Nested function declarations become children.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DocumentSymbol {
    pub name: String,
    pub kind: SymbolKind,
    pub span: Span,
    pub selection: Span,
    pub children: Vec<DocumentSymbol>,
}

/// The outline of `path`; empty when the file is not mounted.
#[must_use]
pub fn document_symbols(workspace: &Workspace, path: &str) -> Vec<DocumentSymbol> {
    let Some(entry) = workspace.file(path) else {
        return Vec::new();
    };
    let ast = &entry.parsed.ast;
    block_symbols(ast, entry.parsed.chunk.body)
}

fn block_symbols(ast: &Ast, block: BlockId) -> Vec<DocumentSymbol> {
    let mut symbols = Vec::new();
    for &stat_id in &ast.block(block).stats {
        let stat = ast.stat(stat_id);
        match &stat.kind {
            StatKind::FunctionDecl { name, func } => {
                symbols.push(function_symbol(
                    ast,
                    &render_func_name(name),
                    name_selection(name),
                    stat.span,
                    func,
                ));
            }
            StatKind::LocalFunction { name, func } => {
                symbols.push(function_symbol(ast, &name.text, name.span, stat.span, func));
            }
            StatKind::LocalAssign { names, values } => {
                for (position, name) in names.iter().enumerate() {
                    symbols.push(declaration_symbol(
                        ast,
                        &name.text,
                        name.span,
                        stat.span,
                        values.get(position).copied(),
                    ));
                }
            }
            StatKind::Assign { targets, values } => {
                for (position, &target) in targets.iter().enumerate() {
                    let ExprKind::NameRef(name) = &ast.expr(target).kind else {
                        continue;
                    };
                    symbols.push(declaration_symbol(
                        ast,
                        name,
                        ast.expr(target).span,
                        stat.span,
                        values.get(position).copied(),
                    ));
                }
            }
            _ => {}
        }
    }
    symbols
}

/// A named binding: a function symbol when its initialiser is a function
/// literal (`local f = function …`, `G = function …`), else a variable.
fn declaration_symbol(
    ast: &Ast,
    name: &str,
    selection: Span,
    stat_span: Span,
    value: Option<dcs_lua_syntax::ast::ExprId>,
) -> DocumentSymbol {
    let initialiser_function = value.and_then(|id| match &ast.expr(id).kind {
        ExprKind::Function(func) => Some(func),
        _ => None,
    });
    match initialiser_function {
        Some(func) => function_symbol(ast, name, selection, stat_span, func),
        None => DocumentSymbol {
            name: name.to_string(),
            kind: SymbolKind::Variable,
            span: stat_span,
            selection,
            children: Vec::new(),
        },
    }
}

fn function_symbol(
    ast: &Ast,
    name: &str,
    selection: Span,
    span: Span,
    func: &FuncBody,
) -> DocumentSymbol {
    DocumentSymbol {
        name: name.to_string(),
        kind: SymbolKind::Function,
        span,
        selection,
        children: block_symbols(ast, func.body),
    }
}

/// `a.b.c` / `a.b:m` rendering of a function statement's name — shared
/// with hover's headline.
pub(crate) fn render_func_name(name: &FuncName) -> String {
    let mut rendered = name
        .segments
        .iter()
        .map(|segment| segment.text.as_str())
        .collect::<Vec<_>>()
        .join(".");
    if let Some(method) = &name.method {
        rendered.push(':');
        rendered.push_str(&method.text);
    }
    rendered
}

fn name_selection(name: &FuncName) -> Span {
    let start = name
        .segments
        .first()
        .map_or(0, |segment| segment.span.start);
    let end = name
        .method
        .as_ref()
        .map(|method| method.span.end)
        .or_else(|| name.segments.last().map(|segment| segment.span.end))
        .unwrap_or(start);
    Span::new(start, end)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outline(src: &str) -> Vec<DocumentSymbol> {
        let mut ws = Workspace::new();
        ws.set_source("f.lua", src);
        document_symbols(&ws, "f.lua")
    }

    #[test]
    fn functions_locals_and_globals_outline() {
        let symbols = outline(
            "function lib.sub:method() local inner = 1 end\nlocal x = 1\nGLOBAL = 2\nlocal f = function() end",
        );
        let names: Vec<_> = symbols.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["lib.sub:method", "x", "GLOBAL", "f"]);
        assert_eq!(symbols[0].kind, SymbolKind::Function);
        assert_eq!(symbols[0].children[0].name, "inner");
        assert_eq!(symbols[3].kind, SymbolKind::Function);
    }
}
