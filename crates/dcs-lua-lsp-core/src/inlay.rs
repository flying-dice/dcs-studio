//! Inferred-type inlay hints.
//!
//! One `: <type>` hint after each `local` binding that has no explicit
//! `@type` annotation and whose initializer infers to a concrete type. The
//! editor draws them as ghost text, like VS Code. `Unknown`/`Any` are
//! skipped — a hint nobody can act on is noise.

use dcs_lua_syntax::Type;
use dcs_lua_syntax::ast::StatKind;

use crate::annot::block_at;
use crate::infer::infer_type;
use crate::workspace::Workspace;

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
    for stat in &ast.stats {
        let StatKind::LocalAssign { names, values } = &stat.kind else {
            continue;
        };
        // An explicit `@type` annotation already states the type — no hint.
        if block_at(entry, stat.span.start).var_type.is_some() {
            continue;
        }
        for (position, name) in names.iter().enumerate() {
            let Some(&value) = values.get(position) else {
                continue;
            };
            let ty = infer_type(workspace, path, value);
            if matches!(ty, Type::Unknown | Type::Any) {
                continue;
            }
            hints.push(InlayHint {
                offset: name.span.end,
                label: format!(": {}", ty.render()),
                kind: "Type".to_string(),
            });
        }
    }
    hints
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws(src: &str) -> Workspace {
        let mut ws = Workspace::new();
        ws.set_source("main.lua", src);
        ws
    }

    #[test]
    fn literal_locals_get_hints() {
        let ws = ws("local s = 'x'\nlocal n = 1\nlocal b = true\n");
        let hints = inlay_hints(&ws, "main.lua");
        let labels: Vec<&str> = hints.iter().map(|h| h.label.as_str()).collect();
        assert_eq!(labels, vec![": string", ": number", ": boolean"]);
    }

    #[test]
    fn annotated_local_gets_no_hint() {
        let ws = ws("--- @type number\nlocal n = some_call()\n");
        assert!(inlay_hints(&ws, "main.lua").is_empty());
    }

    #[test]
    fn unknown_inference_skipped() {
        let ws = ws("local x = undefined_call()\n");
        assert!(inlay_hints(&ws, "main.lua").is_empty());
    }
}
