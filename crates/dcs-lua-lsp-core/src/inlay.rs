//! Inferred-type inlay hints.
//!
//! Two kinds, both drawn as `: <type>` ghost text by the editor (like VS
//! Code):
//!
//! - **Local bindings:** after each `local x = …` whose initializer infers to
//!   a concrete type and which carries no explicit `@type`.
//! - **Function signatures:** after each parameter whose type the body implies
//!   (`param_infer`), and after the parameter list for the inferred return
//!   type — on every function form (`local function`, `function a.b.c`,
//!   `function obj:m`, and `function(…)` literals).
//!
//! `Unknown`/`Any` and un-inferable parameters/returns are skipped — a hint
//! nobody can act on is noise. Hints are isolated to this renderer; the
//! inference layer (`infer`, `param_infer`) does the thinking.

use dcs_lua_syntax::Type;
use dcs_lua_syntax::ast::{ExprKind, FuncBody, StatKind};
use dcs_lua_syntax::token::{SpannedTrivia, Trivia};

use crate::annot::block_at;
use crate::infer::infer_type;
use crate::param_infer::{is_void_return, param_types, return_type};
use crate::workspace::{FileEntry, Workspace};

/// One inferred-type inlay hint: a `: <type>` label drawn after `offset`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlayHint {
    pub offset: u32,
    pub label: String,
    pub kind: String,
}

/// Inferred-type inlay hints for one file.
#[must_use]
pub fn inlay_hints(workspace: &Workspace, path: &str) -> Vec<InlayHint> {
    let Some(entry) = workspace.file(path) else {
        return Vec::new();
    };
    let ast = &entry.parsed.ast;
    let mut hints = Vec::new();

    // The flat arenas visit every node once, at any nesting depth.
    for stat in &ast.stats {
        match &stat.kind {
            StatKind::LocalAssign { names, values } => {
                // An explicit `@type` already states the type — no hint.
                if block_at(entry, stat.span.start).var_type.is_some() {
                    continue;
                }
                for (position, name) in names.iter().enumerate() {
                    let Some(&value) = values.get(position) else {
                        continue;
                    };
                    let ty = infer_type(workspace, path, value);
                    if let Some(label) = type_label(&ty) {
                        hints.push(type_hint(name.span.end, label));
                    }
                }
            }
            StatKind::Assign { targets, values } => {
                if block_at(entry, stat.span.start).var_type.is_some() {
                    continue;
                }
                for (i, &target) in targets.iter().enumerate() {
                    let Some(&value) = values.get(i) else { continue };
                    if let ExprKind::Field { name, .. } = &ast.expr(target).kind {
                        let ty = infer_type(workspace, path, value);
                        if let Some(label) = type_label(&ty) {
                            hints.push(type_hint(name.span.end, label));
                        }
                    }
                }
            }
            StatKind::LocalFunction { func, .. } | StatKind::FunctionDecl { func, .. } => {
                emit_signature(workspace, path, entry, Some(stat.span.start), func, &mut hints);
            }
            _ => {}
        }
    }
    // Anonymous function literals: a `local f = function(x) … end` and the
    // like. Named declarations carry their `FuncBody` inline on the statement
    // (above), so each function is emitted exactly once.
    for expr in &ast.exprs {
        if let ExprKind::Function(func) = &expr.kind {
            emit_signature(workspace, path, entry, None, func, &mut hints);
        }
    }

    hints
}

/// Push the parameter and return-type hints for one function. `decl_start` is
/// the declaration's byte offset for `@param`/annotation lookup (`None` for a
/// literal, which has no annotation block).
fn emit_signature(
    workspace: &Workspace,
    path: &str,
    entry: &FileEntry,
    decl_start: Option<u32>,
    func: &FuncBody,
    hints: &mut Vec<InlayHint>,
) {
    let params = param_types(workspace, path, func, decl_start);
    for (param, ty) in func.params.iter().zip(&params) {
        if let Some(ty) = ty
            && let Some(label) = type_label(ty)
        {
            hints.push(type_hint(param.span.end, label));
        }
    }
    let return_offset = locate_close_paren(&entry.source, &entry.trivia, func);
    if let Some(offset) = return_offset {
        if let Some(ty) = return_type(workspace, path, func, &params)
            && let Some(label) = type_label(&ty)
        {
            hints.push(type_hint(offset, label));
        } else if is_void_return(workspace, path, func) {
            hints.push(type_hint(offset, ": void".to_string()));
        }
    }
}

/// The `: <type>` label for a hint, or `None` for a non-actionable type.
fn type_label(ty: &Type) -> Option<String> {
    if matches!(ty, Type::Unknown | Type::Any) {
        None
    } else {
        Some(format!(": {}", ty.render()))
    }
}

fn type_hint(offset: u32, label: String) -> InlayHint {
    InlayHint { offset, label, kind: "Type".to_string() }
}

/// The byte offset just after the parameter list's closing `)`. The AST keeps
/// no paren span, so scan the source from the end of the last parameter (or
/// the function start, for `()`) up to the body, skipping any `)` that falls
/// inside a comment. `None` when no `)` is found (malformed source) — the
/// return hint is then omitted rather than misplaced.
fn locate_close_paren(source: &str, trivia: &[SpannedTrivia], func: &FuncBody) -> Option<u32> {
    let lo = func.params.last().map_or(func.span.start, |param| param.span.end) as usize;
    let bytes = source.as_bytes();
    let hi = bytes.len().min(func.span.end as usize);
    bytes[lo..hi]
        .iter()
        .enumerate()
        .find(|(index, byte)| **byte == b')' && !in_comment(trivia, (lo + *index) as u32))
        .map(|(index, _)| (lo + index) as u32 + 1)
}

/// Whether `offset` falls inside a comment trivia span (where a `)` is not the
/// real parameter-list close).
fn in_comment(trivia: &[SpannedTrivia], offset: u32) -> bool {
    trivia.iter().any(|spanned| {
        matches!(
            spanned.trivia,
            Trivia::LineComment { .. } | Trivia::LongComment { .. } | Trivia::DocComment { .. }
        ) && spanned.span.start <= offset
            && offset < spanned.span.end
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws(src: &str) -> Workspace {
        let mut ws = Workspace::new();
        ws.set_source("main.lua", src);
        ws
    }

    fn labels(src: &str) -> Vec<String> {
        inlay_hints(&ws(src), "main.lua").into_iter().map(|h| h.label).collect()
    }

    /// The hint whose label is `label`, if present, with its offset.
    fn hint_at<'a>(hints: &'a [InlayHint], label: &str) -> Option<&'a InlayHint> {
        hints.iter().find(|h| h.label == label)
    }

    #[test]
    fn literal_locals_get_hints() {
        let labels = labels("local s = 'x'\nlocal n = 1\nlocal b = true\n");
        assert_eq!(labels, vec![": string", ": number", ": boolean"]);
    }

    #[test]
    fn annotated_local_gets_no_hint() {
        assert!(labels("--- @type number\nlocal n = some_call()\n").is_empty());
    }

    #[test]
    fn unknown_inference_skipped() {
        assert!(labels("local x = undefined_call()\n").is_empty());
    }

    #[test]
    fn local_function_param_and_return_hinted() {
        let hints = inlay_hints(&ws("local function f(msg) return msg:upper() end\n"), "main.lua");
        // Parameter `msg: string` sits after the name.
        let param = hint_at(&hints, ": string").expect("a string hint");
        assert!(param.offset > 0);
        // Two `: string` hints: the parameter and the return.
        assert_eq!(hints.iter().filter(|h| h.label == ": string").count(), 2);
    }

    #[test]
    fn return_hint_follows_the_close_paren() {
        let src = "local function f(p) return p + 1 end\n";
        let hints = inlay_hints(&ws(src), "main.lua");
        let paren = src.find(')').unwrap() as u32;
        // The `: number` return hint sits just after the `)`.
        assert!(hints.iter().any(|h| h.label == ": number" && h.offset == paren + 1));
    }

    #[test]
    fn global_function_form_is_hinted() {
        let labels = labels("function M.handle(p) return p .. 'x' end\n");
        assert!(labels.contains(&": string".to_string()));
    }

    #[test]
    fn method_self_is_not_hinted() {
        // `self` is implicit (not in params); only `p` can be hinted.
        let src = "function obj:m(p) return p + 1 end\n";
        let hints = inlay_hints(&ws(src), "main.lua");
        // No hint should land on a `self` (there is no self param span).
        assert!(hints.iter().any(|h| h.label == ": number"));
    }

    #[test]
    fn function_literal_is_hinted() {
        let labels = labels("local f = function(p) return p:lower() end\n");
        assert!(labels.contains(&": string".to_string()));
    }

    #[test]
    fn no_params_return_hint_placed_after_empty_parens() {
        let src = "local function f() return 1 end\n";
        let hints = inlay_hints(&ws(src), "main.lua");
        let paren = src.find(')').unwrap() as u32;
        assert_eq!(hint_at(&hints, ": number").map(|h| h.offset), Some(paren + 1));
    }

    #[test]
    fn comment_paren_does_not_misplace_return_hint() {
        let src = "local function f(p) --[[ ) ]]\n return p + 1 end\n";
        let hints = inlay_hints(&ws(src), "main.lua");
        let real_paren = src.find(") --").unwrap() as u32;
        assert!(hints.iter().any(|h| h.label == ": number" && h.offset == real_paren + 1));
    }

    #[test]
    fn literal_local_inside_function_body_is_hinted() {
        // The flat-arena walk reaches nested local bindings too.
        let labels = labels("local function f() local s = 'x' end\n");
        assert!(labels.contains(&": string".to_string()));
    }

    #[test]
    fn unannotated_param_with_no_evidence_has_no_hint() {
        let hints = inlay_hints(&ws("local function f(p) return p end\n"), "main.lua");
        assert!(hints.is_empty());
    }

    #[test]
    fn void_function_gets_void_return_hint() {
        let labels = labels("local function log(msg) print(msg) end\n");
        assert!(labels.contains(&": void".to_string()));
    }

    #[test]
    fn function_with_return_does_not_get_void_hint() {
        assert!(!labels("local function f() return 1 end\n").contains(&": void".to_string()));
    }

    #[test]
    fn bare_return_only_function_gets_void_hint() {
        let labels = labels("local function f(p) if p then return end end\n");
        assert!(labels.contains(&": void".to_string()));
    }

    #[test]
    fn field_assignment_gets_type_hint() {
        let labels = labels("local M = {}\nM.name = \"x\"\nM.count = 1\n");
        assert!(labels.contains(&": string".to_string()));
        assert!(labels.contains(&": number".to_string()));
    }

    #[test]
    fn annotated_field_assignment_gets_no_hint() {
        assert!(labels("--- @type number\nM.n = some_call()\n").is_empty());
    }
}
