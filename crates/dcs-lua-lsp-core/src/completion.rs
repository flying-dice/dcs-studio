//! `textDocument/completion`: the candidate set at the cursor.
//!
//! The cursor's context decides the set. A member access (`recv.`) yields the
//! members of `recv` — the fields of its `@class`/`@type` named type
//! (inherited included, walking the parent chain) unioned with the
//! dotted-global statements under `recv.` (the generated `.d.lua` path the
//! resolver already feeds). A bare identifier yields the locals in scope
//! (innermost-shadowing, deduped) and the workspace global roots. Nothing is
//! offered inside a comment or string, after a receiver with no known
//! members, or over whitespace.

use std::collections::{HashMap, HashSet};

use dcs_lua_syntax::Type;
use dcs_lua_syntax::FieldAnno;
use dcs_lua_syntax::ast::{Ast, ExprKind, FuncBody};
use dcs_lua_syntax::span::Span;
use dcs_lua_syntax::token::Trivia;

use crate::annot::block_at;
use crate::hover::title;
use crate::resolve::{
    Decl, decl_label, dotted_children, global_decls, global_roots, resolve, resolve_dotted,
    visible_locals,
};
use crate::ty_table::TypeTable;
use crate::workspace::{FileEntry, Workspace};

/// One completion suggestion at a cursor: the inserted `label`, its `kind`
/// (`function`/`variable`/`field`), a `detail` type-or-signature line, the
/// `documentation` doc run, and the `insert_text` — a `${1:param}` snippet
/// when `insert_text_format` is `snippet`, else the bare label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionItem {
    pub label: String,
    pub kind: String,
    pub detail: String,
    pub documentation: String,
    pub insert_text: String,
    pub insert_text_format: String,
}

// `kind` and `insert_text_format` are strings by design — the wire contract,
// not loose typing: the model (`lspcore::CompletionItem`) and the LSP/JSON
// transports all carry them as strings. `lua-analyzer` maps the kind string to
// its LSP `CompletionItemKind` (an unknown value degrades to a generic icon,
// the same forward-compat LSP itself uses), and `studio-mcp` passes them
// through. These constants are the one definition of the value set.
const PLAINTEXT: &str = "plaintext";
const SNIPPET: &str = "snippet";

const KIND_FUNCTION: &str = "function";
const KIND_VARIABLE: &str = "variable";
const KIND_FIELD: &str = "field";

/// The completion candidates at byte `offset` in `path`. Empty when `path`
/// is not mounted, the cursor sits in a comment or string, the member
/// receiver resolves to nothing, or there is no partial word to complete.
#[must_use]
pub fn complete(workspace: &Workspace, path: &str, offset: u32) -> Vec<CompletionItem> {
    let Some(entry) = workspace.file(path) else {
        return Vec::new();
    };
    if in_comment_or_string(entry, offset) {
        return Vec::new();
    }
    match context_at(&entry.source, offset) {
        Context::Member { receiver, prefix } => {
            member_items(workspace, path, &receiver, &prefix, offset)
        }
        Context::Ident { prefix } => ident_items(workspace, entry, &prefix, offset),
    }
}

// ---- cursor context ---------------------------------------------------------

/// What the cursor is completing.
enum Context {
    /// A member access `receiver.<prefix>` (or `receiver:<prefix>`).
    Member { receiver: String, prefix: String },
    /// A bare identifier with the partial word `prefix`.
    Ident { prefix: String },
}

/// The completion context immediately left of `offset`. Identifier and
/// separator bytes are ASCII, so the scan walks raw bytes — safe inside
/// multi-byte runs, whose continuation bytes never match an ASCII class.
fn context_at(source: &str, offset: u32) -> Context {
    let bytes = source.as_bytes();
    let end = (offset as usize).min(bytes.len());
    let word_start = scan_back(bytes, end, is_ident_byte);
    let prefix = slice(bytes, word_start, end);
    if word_start > 0 && matches!(bytes.get(word_start - 1).copied(), Some(b'.' | b':')) {
        let sep = word_start - 1;
        let start = scan_back(bytes, sep, is_receiver_byte);
        let receiver = slice(bytes, start, sep).trim_matches('.').to_string();
        if !receiver.is_empty() {
            return Context::Member { receiver, prefix };
        }
    }
    Context::Ident { prefix }
}

/// The earliest index reachable from `end` by walking back over bytes that
/// satisfy `keep`. Byte-wise and panic-free: identifier and separator bytes
/// are ASCII, so a UTF-8 continuation byte never matches.
fn scan_back(bytes: &[u8], end: usize, keep: fn(u8) -> bool) -> usize {
    let mut start = end;
    while start > 0 && bytes.get(start - 1).copied().is_some_and(keep) {
        start -= 1;
    }
    start
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn is_receiver_byte(b: u8) -> bool {
    is_ident_byte(b) || b == b'.'
}

fn slice(bytes: &[u8], start: usize, end: usize) -> String {
    bytes
        .get(start..end)
        .and_then(|chunk| std::str::from_utf8(chunk).ok())
        .unwrap_or("")
        .to_string()
}

/// Whether `offset` sits inside a comment trivium or a string literal —
/// completion stays silent there.
fn in_comment_or_string(entry: &FileEntry, offset: u32) -> bool {
    let in_comment = entry.trivia.iter().any(|spanned| {
        matches!(
            spanned.trivia,
            Trivia::LineComment { .. } | Trivia::LongComment { .. } | Trivia::DocComment { .. }
        ) && span_contains(spanned.span, offset)
    });
    if in_comment {
        return true;
    }
    entry
        .parsed
        .ast
        .exprs
        .iter()
        .any(|expr| matches!(expr.kind, ExprKind::Str { .. }) && span_contains(expr.span, offset))
}

fn span_contains(span: Span, offset: u32) -> bool {
    span.start <= offset && offset <= span.end
}

// ---- member completion ------------------------------------------------------

/// Members of `receiver`: the fields of its named type (with inherited
/// fields) unioned with the dotted-global statements under `receiver.`,
/// prefix-filtered. A named-type field shadows a dotted-global of the same
/// name. Empty when nothing matches — never a fall-through to globals.
fn member_items(
    workspace: &Workspace,
    path: &str,
    receiver: &str,
    prefix: &str,
    offset: u32,
) -> Vec<CompletionItem> {
    let mut items = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    if let Some(class) = receiver_class(workspace, path, receiver, offset) {
        let table = TypeTable::build(workspace);
        for ancestor in table.ancestry(&class) {
            let Some(def) = table.class(&ancestor) else {
                continue;
            };
            for field in &def.fields {
                if field.name.starts_with(prefix) && seen.insert(field.name.clone()) {
                    items.push(field_item(field));
                }
            }
        }
    }

    // Named-type fields went into `seen` first, so a dotted-global of the same
    // name is shadowed here — the union, not a duplicate listing.
    for (segment, decl_path, decl) in dotted_children(workspace, receiver) {
        if segment.starts_with(prefix)
            && seen.insert(segment.clone())
            && let Some(entry) = workspace.file(&decl_path)
        {
            items.push(item_for(entry, &segment, &decl, KIND_FIELD));
        }
    }

    sort_by_label(&mut items);
    items
}

/// The named type `receiver` carries: a `@class` directly on its declaration
/// (the symbol *is* that class), else an explicit `@type ClassName`. `None`
/// when `receiver` resolves to nothing or to a non-named type.
fn receiver_class(
    workspace: &Workspace,
    path: &str,
    receiver: &str,
    offset: u32,
) -> Option<String> {
    let (decl_path, decl) = if receiver.contains('.') {
        resolve_dotted(workspace, path, receiver)?
    } else {
        resolve(workspace, path, receiver, offset)?
    };
    let entry = workspace.file(&decl_path)?;
    let block = block_at(entry, decl.start());
    if let Some(class) = block.class_name {
        return Some(class);
    }
    match block.var_type {
        Some(Type::Named(name)) => Some(name),
        _ => None,
    }
}

/// A completion item for a `@field` of a named type: a function field becomes
/// a snippet, everything else a plain field.
fn field_item(field: &FieldAnno) -> CompletionItem {
    if let Type::Function { params, .. } = &field.ty {
        CompletionItem {
            label: field.name.clone(),
            kind: KIND_FUNCTION.to_string(),
            detail: field.ty.render(),
            documentation: String::new(),
            insert_text: snippet_from_types(&field.name, params),
            insert_text_format: SNIPPET.to_string(),
        }
    } else {
        CompletionItem {
            label: field.name.clone(),
            kind: KIND_FIELD.to_string(),
            detail: field.ty.render(),
            documentation: String::new(),
            insert_text: field.name.clone(),
            insert_text_format: PLAINTEXT.to_string(),
        }
    }
}

// ---- bare-identifier completion ---------------------------------------------

/// In-scope locals plus workspace global roots, prefix-filtered. Locals
/// shadow globals: a name bound in scope appears once, resolved to its
/// innermost binding. Empty for an empty prefix (whitespace / explicit
/// invoke is the front-end's call, not the engine's guess).
fn ident_items(
    workspace: &Workspace,
    entry: &FileEntry,
    prefix: &str,
    offset: u32,
) -> Vec<CompletionItem> {
    if prefix.is_empty() {
        return Vec::new();
    }
    let mut items = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for decl in visible_locals(&entry.parsed, offset) {
        let label = decl_label(&decl);
        if label.starts_with(prefix) && seen.insert(label.clone()) {
            items.push(item_for(entry, &label, &decl, KIND_VARIABLE));
        }
    }

    let simple: HashMap<String, (String, Decl)> = global_decls(workspace)
        .into_iter()
        .map(|(decl_path, decl)| (decl_label(&decl), (decl_path, decl)))
        .collect();
    for root in global_roots(workspace) {
        if !root.starts_with(prefix) || !seen.insert(root.clone()) {
            continue;
        }
        match simple.get(&root) {
            Some((decl_path, decl)) => {
                if let Some(global_entry) = workspace.file(decl_path) {
                    items.push(item_for(global_entry, &root, decl, KIND_VARIABLE));
                }
            }
            None => items.push(root_item(&root)),
        }
    }

    sort_by_label(&mut items);
    items
}

/// A global that only ever appears dotted (`DCS` seen only in `DCS.x = …`):
/// a plain table root, no declaration to title or document.
fn root_item(label: &str) -> CompletionItem {
    CompletionItem {
        label: label.to_string(),
        kind: KIND_VARIABLE.to_string(),
        detail: "global".to_string(),
        documentation: String::new(),
        insert_text: label.to_string(),
        insert_text_format: PLAINTEXT.to_string(),
    }
}

// ---- shared item shaping ----------------------------------------------------

/// Build an item from a declaration under an explicit `label` (the bare name
/// for a local/global, the trailing segment for a dotted member). A function
/// declaration becomes a `${1:param}` snippet; `var_kind` names the
/// non-function kind (`variable` in scope, `field` as a member). Detail is
/// the hover title and documentation is the declaration's doc run — the same
/// sources hover reads.
fn item_for<'a>(
    entry: &'a FileEntry,
    label: &str,
    decl: &Decl<'a>,
    var_kind: &str,
) -> CompletionItem {
    let ast = &entry.parsed.ast;
    let (kind, insert_text, insert_text_format) = match func_of(ast, decl) {
        Some(func) => (
            KIND_FUNCTION.to_string(),
            snippet_from_params(label, func),
            SNIPPET.to_string(),
        ),
        None => (var_kind.to_string(), label.to_string(), PLAINTEXT.to_string()),
    };
    CompletionItem {
        label: label.to_string(),
        kind,
        detail: title(ast, decl),
        documentation: block_at(entry, decl.start()).doc,
        insert_text,
        insert_text_format,
    }
}

/// The function body a declaration binds — a `function` form directly, or a
/// `local`/global assigned a function literal (`f = function() end`), so a
/// callable value completes as a function with a signature snippet.
fn func_of<'a>(ast: &'a Ast, decl: &Decl<'a>) -> Option<&'a FuncBody> {
    match decl {
        Decl::LocalFunction { func, .. } | Decl::GlobalFunction { func, .. } => Some(func),
        Decl::Local {
            value: Some(value), ..
        }
        | Decl::GlobalAssign {
            value: Some(value), ..
        } => match &ast.expr(*value).kind {
            ExprKind::Function(func) => Some(func),
            _ => None,
        },
        _ => None,
    }
}

/// `label(${1:p}, ${2:q})` from a function's parameter names; a vararg
/// becomes a trailing `...` placeholder.
fn snippet_from_params(label: &str, func: &FuncBody) -> String {
    let mut placeholders: Vec<String> = func
        .params
        .iter()
        .enumerate()
        .map(|(index, param)| placeholder(index, &param.text))
        .collect();
    if func.is_vararg {
        placeholders.push(placeholder(placeholders.len(), "..."));
    }
    format!("{label}({})", placeholders.join(", "))
}

/// `label(${1:T}, ${2:U})` from a function type's parameter types — the field
/// form, where parameters are typed but unnamed.
fn snippet_from_types(label: &str, params: &[Type]) -> String {
    let placeholders: Vec<String> = params
        .iter()
        .enumerate()
        .map(|(index, ty)| placeholder(index, &ty.render()))
        .collect();
    format!("{label}({})", placeholders.join(", "))
}

/// One `${n:text}` snippet placeholder, 1-based.
fn placeholder(index: usize, text: &str) -> String {
    format!("${{{}:{}}}", index + 1, text)
}

fn sort_by_label(items: &mut [CompletionItem]) {
    items.sort_by(|a, b| a.label.cmp(&b.label));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn single(src: &str) -> Workspace {
        let mut ws = Workspace::new();
        ws.set_source("main.lua", src);
        ws
    }

    /// The byte offset just past the `occurrence`-th (0-based) `needle`.
    fn after(src: &str, needle: &str, occurrence: usize) -> u32 {
        let mut pos = 0usize;
        let mut remaining = occurrence;
        loop {
            let found = src[pos..].find(needle).expect("needle present") + pos;
            if remaining == 0 {
                return (found + needle.len()) as u32;
            }
            remaining -= 1;
            pos = found + needle.len();
        }
    }

    fn labels(items: &[CompletionItem]) -> Vec<&str> {
        items.iter().map(|item| item.label.as_str()).collect()
    }

    fn find<'a>(items: &'a [CompletionItem], label: &str) -> &'a CompletionItem {
        items
            .iter()
            .find(|item| item.label == label)
            .unwrap_or_else(|| panic!("no completion item {label:?} in {:?}", labels(items)))
    }

    #[test]
    fn bare_identifier_offers_scope_local() {
        let src = "local rng = 1\nmissionStart = function() end\nrn\n";
        let ws = single(src);
        let items = complete(&ws, "main.lua", after(src, "\nrn", 0));
        assert_eq!(labels(&items), vec!["rng"], "{:?}", labels(&items));
        assert_eq!(find(&items, "rng").kind, KIND_VARIABLE);
    }

    #[test]
    fn bare_identifier_offers_workspace_global() {
        let src = "local rng = 1\nmissionStart = function() end\nmission\n";
        let ws = single(src);
        let items = complete(&ws, "main.lua", after(src, "\nmission", 0));
        let names = labels(&items);
        assert!(names.contains(&"missionStart"), "{names:?}");
        assert_eq!(find(&items, "missionStart").kind, KIND_FUNCTION);
    }

    #[test]
    fn local_shadowing_a_global_appears_once_as_the_local() {
        let src = "trigger = 1\nlocal function use()\n  local trigger = 2\n  trig\nend\n";
        let ws = single(src);
        let items = complete(&ws, "main.lua", after(src, "  trig", 0));
        let triggers: Vec<_> = items.iter().filter(|i| i.label == "trigger").collect();
        assert_eq!(triggers.len(), 1, "{:?}", labels(&items));
        assert_eq!(triggers[0].kind, KIND_VARIABLE);
    }

    #[test]
    fn dotted_global_members_complete_after_the_dot() {
        let src = "DCS = {}\nDCS.getPlayerUnit = function() end\nDCS.getMissionName = function() end\nlocal n = DCS.\n";
        let ws = single(src);
        let items = complete(&ws, "main.lua", after(src, "DCS.", 1));
        let names = labels(&items);
        assert!(names.contains(&"getPlayerUnit"), "{names:?}");
        assert!(names.contains(&"getMissionName"), "{names:?}");
        assert_eq!(find(&items, "getPlayerUnit").kind, KIND_FUNCTION);
    }

    #[test]
    fn dotted_member_prefix_filters() {
        let src = "DCS = {}\nDCS.getPlayerUnit = function() end\nDCS.setPause = function() end\nlocal n = DCS.get\n";
        let ws = single(src);
        let items = complete(&ws, "main.lua", after(src, "DCS.get", 1));
        let names = labels(&items);
        assert_eq!(names, vec!["getPlayerUnit"], "{names:?}");
    }

    #[test]
    fn typed_table_members_come_from_at_class_fields() {
        let src = "---@class World\n---@field getTime fun(): number\n---@field name string\nWorld = {}\nlocal w = World.\n";
        let ws = single(src);
        let items = complete(&ws, "main.lua", after(src, "World.", 0));
        let names = labels(&items);
        assert!(names.contains(&"getTime"), "{names:?}");
        assert!(names.contains(&"name"), "{names:?}");
        assert_eq!(find(&items, "getTime").kind, KIND_FUNCTION);
        assert_eq!(find(&items, "name").kind, KIND_FIELD);
    }

    #[test]
    fn function_completion_carries_a_param_snippet() {
        let src = "function spawnUnit(country, name)\nend\nspawn\n";
        let ws = single(src);
        let items = complete(&ws, "main.lua", after(src, "\nspawn", 0));
        let item = find(&items, "spawnUnit");
        assert_eq!(item.insert_text, "spawnUnit(${1:country}, ${2:name})");
        assert_eq!(item.insert_text_format, SNIPPET);
    }

    #[test]
    fn completion_item_carries_documentation() {
        let src = "--- Spawn a unit in the mission.\nfunction spawnUnit()\nend\nspawn\n";
        let ws = single(src);
        let items = complete(&ws, "main.lua", after(src, "\nspawn", 0));
        assert!(
            find(&items, "spawnUnit")
                .documentation
                .contains("Spawn a unit"),
            "doc missing"
        );
    }

    #[test]
    fn no_completion_inside_a_comment() {
        let src = "local rng = 1\n-- r\n";
        let ws = single(src);
        let items = complete(&ws, "main.lua", after(src, "-- r", 0));
        assert!(items.is_empty(), "{:?}", labels(&items));
    }

    #[test]
    fn no_completion_inside_a_string() {
        let src = "local rng = 1\nlocal s = \"rng\"\n";
        let ws = single(src);
        let items = complete(&ws, "main.lua", after(src, "\"rn", 0));
        assert!(items.is_empty(), "{:?}", labels(&items));
    }

    #[test]
    fn unresolved_receiver_offers_nothing_not_a_global_fallback() {
        let src = "rng = 1\nlocal x = mystery()\nlocal y = x.\n";
        let ws = single(src);
        let items = complete(&ws, "main.lua", after(src, "x.", 0));
        assert!(items.is_empty(), "{:?}", labels(&items));
    }

    #[test]
    fn empty_prefix_over_whitespace_offers_nothing() {
        let src = "local rng = 1\n\n";
        let ws = single(src);
        let items = complete(&ws, "main.lua", after(src, "\n\n", 0));
        assert!(items.is_empty(), "{:?}", labels(&items));
    }
}
