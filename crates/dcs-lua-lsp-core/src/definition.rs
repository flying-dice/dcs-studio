//! `textDocument/definition`: the declaration the identifier under the
//! cursor binds to.
//!
//! Shaped exactly like [`crate::hover`] — `ident_at` finds the identifier,
//! then the global-first resolution order (innermost lexical scope, then
//! file-level globals, then workspace-level globals) names the declaration —
//! and returns the span of the declaration's own name so the caret lands on
//! it. The cursor already sitting on a declaration resolves to itself.

use dcs_lua_syntax::span::Span;

use crate::resolve::{Ident, ident_at, resolve, resolve_dotted};
use crate::workspace::Workspace;

/// A span in a workspace file — a go-to-definition or find-usages target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Location {
    pub path: String,
    pub span: Span,
}

/// The definition site of the symbol at `offset` in `path`; `None` over
/// whitespace, keywords, or identifiers that resolve to nothing.
#[must_use]
pub fn definition(workspace: &Workspace, path: &str, offset: u32) -> Option<Location> {
    // A `require("mod")` string resolves to its module file (issue #51); an
    // identifier resolves through the scope chain. The cursor is in at most one.
    if let Some(location) = crate::requires::require_definition(workspace, path, offset) {
        return Some(location);
    }
    let (decl_path, span) = resolved_name(workspace, path, offset)?;
    Some(Location {
        path: decl_path,
        span,
    })
}

/// The declaring file and the span of the declaration's name for the symbol
/// at `offset` — the shared resolution behind definition and find-references.
pub(crate) fn resolved_name(
    workspace: &Workspace,
    path: &str,
    offset: u32,
) -> Option<(String, Span)> {
    let entry = workspace.file(path)?;
    let (decl_path, decl) = match ident_at(&entry.parsed, offset)? {
        Ident::Decl(decl) => (path.to_string(), decl),
        Ident::Use { name } => resolve(workspace, path, name, offset)?,
        Ident::Field { dotted } => resolve_dotted(workspace, path, &dotted)?,
    };
    Some((decl_path, decl.name_span()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Byte offset of the `nth` (0-based) occurrence of `needle` in `src`.
    fn at(src: &str, needle: &str, nth: usize) -> u32 {
        src.match_indices(needle).nth(nth).expect("needle").0 as u32
    }

    #[test]
    fn definition_of_a_local_use_lands_on_its_declaration() {
        let mut ws = Workspace::new();
        let src = "local x = 1\nreturn x + x\n";
        ws.set_source("m.lua", src);
        // The use in `return x` resolves back to the declaration's name span.
        let loc = definition(&ws, "m.lua", at(src, "x", 1)).expect("definition");
        assert_eq!(loc.path, "m.lua");
        assert_eq!(loc.span.start, at(src, "x", 0));
    }

    #[test]
    fn definition_of_a_parameter_use_lands_on_the_parameter() {
        let mut ws = Workspace::new();
        let src = "local function f(qq)\n  return qq * 2\nend\n";
        ws.set_source("m.lua", src);
        let loc = definition(&ws, "m.lua", at(src, "qq", 1)).expect("definition");
        assert_eq!(loc.span.start, at(src, "qq", 0));
    }

    #[test]
    fn definition_resolves_a_global_function_across_files() {
        let mut ws = Workspace::new();
        ws.set_source("lib.lua", "function greet()\n  return 1\nend\n");
        let caller = "greet()\n";
        ws.set_source("main.lua", caller);
        let loc = definition(&ws, "main.lua", at(caller, "greet", 0)).expect("definition");
        assert_eq!(loc.path, "lib.lua");
        // Lands on the function's name, not the `function` keyword.
        assert_eq!(loc.span.start, 9);
    }

    #[test]
    fn definition_of_a_dotted_field_resolves_the_table_function() {
        let mut ws = Workspace::new();
        let src = "lib = {}\nfunction lib.run()\nend\nlib.run()\n";
        ws.set_source("m.lua", src);
        // The `run` in the call `lib.run()` resolves to the declaration's `run`.
        let loc = definition(&ws, "m.lua", at(src, "run", 1)).expect("definition");
        assert_eq!(loc.span.start, at(src, "run", 0));
    }

    #[test]
    fn definition_over_nothing_is_none() {
        let mut ws = Workspace::new();
        let src = "local x = 1\n";
        ws.set_source("m.lua", src);
        // Offset on the `=` resolves to no identifier.
        assert!(definition(&ws, "m.lua", at(src, "=", 0)).is_none());
    }
}
