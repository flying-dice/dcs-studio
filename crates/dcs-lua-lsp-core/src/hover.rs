//! `textDocument/hover`: the declaration card for the identifier under
//! the cursor.
//!
//! Resolution order is the global-first model's: innermost lexical scope,
//! then file-level globals, then workspace-level globals. The card titles
//! the declaration (kind, name, signature or shallowly inferred type) and
//! bodies the contiguous `---` doc run directly above the declaration —
//! read from the cached trivia, never a re-lex. A cross-file global
//! appends `defined in <path>:<line>`.

use dcs_lua_syntax::ast::{Ast, BinOp, ExprId, ExprKind, FuncBody, UnOp};
use dcs_lua_syntax::span::LineIndex;

use crate::resolve::{Decl, Ident, ident_at, resolve, resolve_dotted};
use crate::symbols::render_func_name;
use crate::workspace::{FileEntry, Workspace};

/// One hover card: the declaration headline and the doc body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HoverInfo {
    pub title: String,
    pub body: String,
}

/// The hover card at `offset` in `path`; `None` over whitespace, keywords,
/// or identifiers that resolve to nothing.
#[must_use]
pub fn hover(workspace: &Workspace, path: &str, offset: u32) -> Option<HoverInfo> {
    // A `require("mod")` string hovers as where it resolves (issue #51); the
    // rest of this function cards the identifier under the cursor.
    if let Some(card) = crate::requires::require_hover(workspace, path, offset) {
        return Some(card);
    }
    let entry = workspace.file(path)?;
    let (decl_path, decl) = match ident_at(&entry.parsed, offset)? {
        Ident::Decl(decl) => (path.to_string(), decl),
        Ident::Use { name } => resolve(workspace, path, name, offset)?,
        Ident::Field { dotted } => resolve_dotted(workspace, path, &dotted)?,
    };

    let decl_entry = workspace.file(&decl_path)?;
    let title = title(&decl_entry.parsed.ast, &decl);
    let index = LineIndex::new(&decl_entry.source);
    let (decl_line, _) = index.line_col(decl.start());
    let mut body = doc_run(decl_entry, &index, decl_line);
    if decl_path != path {
        let origin = format!("defined in {decl_path}:{decl_line}");
        body = if body.is_empty() {
            origin
        } else {
            format!("{body}\n\n{origin}")
        };
    }
    Some(HoverInfo { title, body })
}

// ---- the headline -----------------------------------------------------------

fn title(ast: &Ast, decl: &Decl<'_>) -> String {
    match decl {
        Decl::Local { name, value, .. } => {
            format!("local {}: {}", name.text, infer(ast, *value))
        }
        Decl::LocalFunction { name, func, .. } => {
            format!("local function {}({})", name.text, render_params(func))
        }
        Decl::Param { name } => format!("parameter {}", name.text),
        Decl::NumericFor { name, .. } => format!("local {}: number", name.text),
        Decl::GenericFor { name, .. } => format!("local {}: unknown", name.text),
        Decl::GlobalAssign { name, value, .. } => {
            format!("global {name}: {}", infer(ast, *value))
        }
        Decl::GlobalFunction { name, func, .. } => {
            format!(
                "function {}({})",
                render_func_name(name),
                render_params(func)
            )
        }
    }
}

fn render_params(func: &FuncBody) -> String {
    let mut params: Vec<&str> = func
        .params
        .iter()
        .map(|param| param.text.as_str())
        .collect();
    if func.is_vararg {
        params.push("...");
    }
    params.join(", ")
}

/// Shallow initializer inference: literal and operator shapes only — no
/// flow, no calls, no field chains. A missing initializer is `nil`.
fn infer(ast: &Ast, value: Option<ExprId>) -> String {
    let Some(value) = value else {
        return "nil".to_string();
    };
    match &ast.expr(value).kind {
        ExprKind::Nil => "nil".to_string(),
        ExprKind::True | ExprKind::False => "boolean".to_string(),
        ExprKind::Number { .. } => "number".to_string(),
        ExprKind::Str { .. } => "string".to_string(),
        ExprKind::Table { .. } => "table".to_string(),
        ExprKind::Function(func) => format!("function({})", render_params(func)),
        ExprKind::Vararg => "...".to_string(),
        ExprKind::Paren(inner) => infer(ast, Some(*inner)),
        ExprKind::Binary { op, .. } => match op {
            BinOp::Add | BinOp::Sub | BinOp::Mul | BinOp::Div | BinOp::Mod | BinOp::Pow => {
                "number".to_string()
            }
            BinOp::Concat => "string".to_string(),
            BinOp::Eq | BinOp::Ne | BinOp::Lt | BinOp::Gt | BinOp::Le | BinOp::Ge => {
                "boolean".to_string()
            }
            BinOp::And | BinOp::Or => "unknown".to_string(),
        },
        ExprKind::Unary { op, .. } => match op {
            UnOp::Not => "boolean".to_string(),
            UnOp::Len | UnOp::Neg => "number".to_string(),
        },
        _ => "unknown".to_string(),
    }
}

// ---- the body ---------------------------------------------------------------

/// The contiguous `---` doc run ending on the line directly above
/// `decl_line`, joined with newlines and trimmed. Texts come from the
/// cached trivia, already marker-stripped.
fn doc_run(entry: &FileEntry, index: &LineIndex, decl_line: u32) -> String {
    crate::annot::doc_lines(entry, index, decl_line)
        .join("\n")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn single(src: &str) -> Workspace {
        let mut ws = Workspace::new();
        ws.set_source("main.lua", src);
        ws
    }

    /// Byte offset of the zero-based `occurrence`-th `needle` in `src`,
    /// pointing at its first byte.
    fn at(src: &str, needle: &str, occurrence: usize) -> u32 {
        let mut pos = 0usize;
        let mut remaining = occurrence;
        loop {
            let found = src[pos..].find(needle).expect("needle present") + pos;
            if remaining == 0 {
                return found as u32;
            }
            remaining -= 1;
            pos = found + needle.len();
        }
    }

    #[test]
    fn local_with_doc_comment_above() {
        let src = "--- The answer.\n--- Chosen carefully.\nlocal answer = 42\nprint(answer)\n";
        let ws = single(src);
        let card = hover(&ws, "main.lua", at(src, "answer", 1)).expect("hover");
        assert_eq!(card.title, "local answer: number");
        assert!(card.body.contains("The answer."));
        assert!(card.body.contains("Chosen carefully."));
    }

    #[test]
    fn hovering_the_declaration_name_itself_answers() {
        let src = "--- Doc here.\nlocal greeting = \"hi\"\n";
        let ws = single(src);
        let card = hover(&ws, "main.lua", at(src, "greeting", 0)).expect("hover");
        assert_eq!(card.title, "local greeting: string");
        assert_eq!(card.body, "Doc here.");
    }

    #[test]
    fn parameter_hover() {
        let src = "local function greet(pilot)\n  return pilot\nend\n";
        let ws = single(src);
        let card = hover(&ws, "main.lua", at(src, "pilot", 1)).expect("hover");
        assert_eq!(card.title, "parameter pilot");
        assert_eq!(card.body, "");
    }

    #[test]
    fn numeric_for_binding_hover() {
        let src = "for wave = 1, 10 do\n  print(wave)\nend\n";
        let ws = single(src);
        let card = hover(&ws, "main.lua", at(src, "wave", 1)).expect("hover");
        assert_eq!(card.title, "local wave: number");
    }

    #[test]
    fn global_resolves_cross_file_with_origin() {
        let mut ws = Workspace::new();
        ws.set_source(
            "lib.lua",
            "--- Greets the pilot.\nfunction helper(name) end\n",
        );
        let use_src = "helper(\"Maverick\")\n";
        ws.set_source("use.lua", use_src);
        let card = hover(&ws, "use.lua", at(use_src, "helper", 0)).expect("hover");
        assert_eq!(card.title, "function helper(name)");
        assert!(card.body.contains("Greets the pilot."));
        assert!(card.body.contains("defined in lib.lua:2"));
    }

    #[test]
    fn local_function_and_dotted_function_titles() {
        let src = "--- Local fn.\nlocal function f(a, ...) end\nfunction lib.sub:method(x) end\n";
        let ws = single(src);
        let local_fn = hover(&ws, "main.lua", at(src, "f(a", 0)).expect("hover");
        assert_eq!(local_fn.title, "local function f(a, ...)");
        assert_eq!(local_fn.body, "Local fn.");
        let dotted = hover(&ws, "main.lua", at(src, "method", 0)).expect("hover");
        assert_eq!(dotted.title, "function lib.sub:method(x)");
    }

    #[test]
    fn shallow_inference_table_driven() {
        let cases = [
            ("local v = \"text\"", "local v: string"),
            ("local v = 1.5", "local v: number"),
            ("local v = {}", "local v: table"),
            ("local v = function(a, b) end", "local v: function(a, b)"),
            ("local v = true", "local v: boolean"),
            ("local v = nil", "local v: nil"),
            ("local v", "local v: nil"),
            ("local v = 1 + 2", "local v: number"),
            ("local v = \"a\" .. \"b\"", "local v: string"),
            ("local v = 1 < 2", "local v: boolean"),
            ("local v = not x", "local v: boolean"),
            ("local v = #t", "local v: number"),
            ("local v = -n", "local v: number"),
            ("local v = ...", "local v: ..."),
            ("local v = call()", "local v: unknown"),
            ("local v = a or b", "local v: unknown"),
            ("local v = a.b.c", "local v: unknown"),
        ];
        for (src, expected) in cases {
            let ws = single(src);
            let card = hover(&ws, "main.lua", at(src, "v", 0)).expect(src);
            assert_eq!(card.title, expected, "for `{src}`");
        }
    }

    #[test]
    fn whitespace_and_unresolved_hover_none() {
        let src = "local x = 1\n\nprint(y)\n";
        let ws = single(src);
        // Offset on the blank line between statements.
        assert_eq!(hover(&ws, "main.lua", at(src, "\n\n", 0) + 1), None);
        // `y` resolves to nothing anywhere.
        assert_eq!(hover(&ws, "main.lua", at(src, "y", 0)), None);
        // Unmounted file.
        assert_eq!(hover(&ws, "other.lua", 0), None);
    }

    #[test]
    fn inner_local_shadows_outer_and_global() {
        let mut ws = Workspace::new();
        ws.set_source("other.lua", "x = \"global text\"\n");
        let src = "local x = 1\nlocal function f(x)\n  do\n    local x = {}\n    print(x)\n  end\n  print(x)\nend\nprint(x)\n";
        ws.set_source("main.lua", src);

        // Innermost do-block local wins.
        let inner = hover(&ws, "main.lua", at(src, "print(x)", 0) + 6).expect("inner");
        assert_eq!(inner.title, "local x: table");
        // Outside the do-block the parameter wins.
        let param = hover(&ws, "main.lua", at(src, "print(x)", 1) + 6).expect("param");
        assert_eq!(param.title, "parameter x");
        // At top level the file-local wins over the other file's global.
        let outer = hover(&ws, "main.lua", at(src, "print(x)", 2) + 6).expect("outer");
        assert_eq!(outer.title, "local x: number");
    }

    #[test]
    fn rhs_of_self_shadowing_local_resolves_to_the_outer_binding() {
        // A plain local's binding is visible only after its declaring
        // statement completes — the RHS `x` still sees the outer `x`.
        let src = "local x = 1\nlocal x = x\n";
        let ws = single(src);
        let card = hover(&ws, "main.lua", at(src, "x", 2)).expect("hover");
        assert_eq!(card.title, "local x: number");
    }

    #[test]
    fn capture_idiom_rhs_does_not_resolve_to_its_own_local() {
        // `local print = print`: nothing in the workspace declares a
        // global `print`, so the RHS resolves to nothing — and in
        // particular NOT to the local being declared.
        let src = "local print = print\n";
        let ws = single(src);
        assert_eq!(hover(&ws, "main.lua", at(src, "print", 1)), None);
    }

    #[test]
    fn forward_use_after_redeclaration_resolves_to_the_new_binding() {
        let src = "local x = 1\nlocal x = \"two\"\nreturn x\n";
        let ws = single(src);
        let card = hover(&ws, "main.lua", at(src, "x", 2)).expect("hover");
        assert_eq!(card.title, "local x: string");
    }

    #[test]
    fn dotted_global_assign_resolves() {
        let src = "M = {}\nM.helper = function(a) end\nM.helper(1)\n";
        let ws = single(src);
        let card = hover(&ws, "main.lua", at(src, "helper", 1)).expect("hover");
        assert_eq!(card.title, "global M.helper: function(a)");
    }
}
