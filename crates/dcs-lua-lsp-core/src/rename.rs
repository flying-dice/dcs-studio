//! `textDocument/rename`: rewrite every occurrence of the symbol under the
//! cursor to a new name.
//!
//! The edit set is exactly what [`crate::references`] finds — declaration and
//! every use, each replaced by `new_name`. For a dotted reference only the
//! final field name is in the set (references records the renameable tail), so
//! `a.b.c → a.b.d` rewrites `c`, never `a` or `b`. The new name is validated
//! as a Lua identifier first; an invalid name or a cursor that resolves to
//! nothing is refused without touching anything.

use dcs_lua_syntax::span::Span;

use crate::definition::Location;
use crate::references::references;
use crate::workspace::Workspace;

/// One replacement: the file, the byte span to replace, and its new text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextEdit {
    pub path: String,
    pub span: Span,
    pub new_text: String,
}

/// Every edit a rename applies across the workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceEdit {
    pub edits: Vec<TextEdit>,
}

/// Why a rename was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameError {
    pub message: String,
}

/// The workspace edit renaming the symbol at `offset` in `path` to
/// `new_name`. Refused when `new_name` is not a valid Lua identifier (or is a
/// reserved word), or when the offset resolves to nothing renameable.
///
/// # Errors
/// Returns [`RenameError`] for an invalid name or an unresolved offset.
pub fn rename(
    workspace: &Workspace,
    path: &str,
    offset: u32,
    new_name: &str,
) -> Result<WorkspaceEdit, RenameError> {
    if !is_identifier(new_name) {
        return Err(RenameError {
            message: format!("`{new_name}` is not a valid Lua identifier"),
        });
    }
    if is_keyword(new_name) {
        return Err(RenameError {
            message: format!("`{new_name}` is a reserved Lua keyword"),
        });
    }
    let locations = references(workspace, path, offset);
    if locations.is_empty() {
        return Err(RenameError {
            message: "there is nothing to rename here".to_string(),
        });
    }
    let edits = locations
        .into_iter()
        .map(|Location { path, span }| TextEdit {
            path,
            span,
            new_text: new_name.to_string(),
        })
        .collect();
    Ok(WorkspaceEdit { edits })
}

/// A valid Lua name: a leading letter or `_`, then letters, digits, or `_`.
fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The 21 reserved words of Lua 5.1 — none may be used as a name.
fn is_keyword(name: &str) -> bool {
    matches!(
        name,
        "and" | "break"
            | "do"
            | "else"
            | "elseif"
            | "end"
            | "false"
            | "for"
            | "function"
            | "if"
            | "in"
            | "local"
            | "nil"
            | "not"
            | "or"
            | "repeat"
            | "return"
            | "then"
            | "true"
            | "until"
            | "while"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(src: &str, needle: &str, nth: usize) -> u32 {
        src.match_indices(needle).nth(nth).expect("needle").0 as u32
    }

    #[test]
    fn rename_rewrites_every_occurrence() {
        let mut ws = Workspace::new();
        let src = "local val = 1\nreturn val + val\n";
        ws.set_source("m.lua", src);
        let edit = rename(&ws, "m.lua", at(src, "val", 0), "renamed").expect("rename");
        assert_eq!(edit.edits.len(), 3);
        assert!(edit.edits.iter().all(|e| e.new_text == "renamed"));
        assert!(edit.edits.iter().all(|e| e.path == "m.lua"));
        // Each span covers exactly the old 3-char name.
        assert!(edit.edits.iter().all(|e| e.span.end - e.span.start == 3));
    }

    #[test]
    fn rename_refuses_an_invalid_identifier() {
        let mut ws = Workspace::new();
        let src = "local val = 1\n";
        ws.set_source("m.lua", src);
        let err = rename(&ws, "m.lua", at(src, "val", 0), "1bad").expect_err("invalid");
        assert!(err.message.contains("not a valid"), "{}", err.message);
    }

    #[test]
    fn rename_refuses_a_keyword() {
        let mut ws = Workspace::new();
        let src = "local val = 1\n";
        ws.set_source("m.lua", src);
        let err = rename(&ws, "m.lua", at(src, "val", 0), "end").expect_err("keyword");
        assert!(err.message.contains("reserved"), "{}", err.message);
    }

    #[test]
    fn rename_refuses_when_nothing_resolves() {
        let mut ws = Workspace::new();
        let src = "local val = 1\n";
        ws.set_source("m.lua", src);
        let err = rename(&ws, "m.lua", at(src, "=", 0), "ok").expect_err("nothing");
        assert!(err.message.contains("nothing"), "{}", err.message);
    }

    #[test]
    fn rename_of_a_dotted_function_touches_only_the_final_segment() {
        let mut ws = Workspace::new();
        let src = "lib = {}\nfunction lib.run()\nend\nlib.run()\n";
        ws.set_source("m.lua", src);
        let edit = rename(&ws, "m.lua", at(src, "run", 0), "go").expect("rename");
        // Declaration `run` and the call's `run` — never `lib`.
        assert_eq!(edit.edits.len(), 2, "{:?}", edit.edits);
        for e in &edit.edits {
            assert_eq!(e.span.end - e.span.start, 3, "span covers `run`");
            assert_eq!(&src[e.span.start as usize..e.span.end as usize], "run");
        }
    }
}
