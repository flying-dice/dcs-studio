//! LuaLS-parity BDD suite (plan "Cucumber harness").
//!
//! Gherkin scenarios under `tests/features/` exercise the type layer the way
//! lua-language-server's own `test/` suite does — type inference, `param-type-mismatch`
//! diagnostics, and inferred-type inlay hints — but scoped to the **DCS Lua
//! 5.1 dialect** only (no multi-runtime-version cases). The cloned LuaLS repo
//! is a read-only reference; the scenarios here are authored, not copied, so
//! the conformance discipline holds.
//!
//! Run with: `cargo test -p dcs-lua-lsp-core --test parity`.
//!
// Cucumber step functions receive their captured arguments by value — the
// macro-generated signatures own each `String`/`usize` — so the
// pass-by-value lint does not apply here.
#![allow(clippy::needless_pass_by_value, clippy::doc_markdown)]

use cucumber::{World, gherkin::Step, given, then, when};
use dcs_lua_lsp_core::{Workspace, all_findings, check_types, inlay_hints, infer_type};

/// The scenario world: a mounted workspace plus the last query results.
#[derive(Debug, Default, World)]
struct LangWorld {
    workspace: Workspace,
    /// The path of the last-mounted file (the "current" file).
    path: String,
    diagnostics: Vec<(String, dcs_lua_syntax::Diagnostic)>,
    hints: Vec<dcs_lua_lsp_core::InlayHint>,
}

#[given(regex = r#"^a Lua file "([^"]+)":$"#)]
fn given_lua_file(world: &mut LangWorld, step: &Step, path: String) {
    let text = step.docstring().cloned().unwrap_or_default();
    world.workspace.set_source(&path, text.trim_start_matches('\n'));
    world.path = path;
}

#[given(regex = r#"^a Lua file "([^"]+)" with:$"#)]
fn given_lua_file_with(world: &mut LangWorld, step: &Step, path: String) {
    given_lua_file(world, step, path);
}

#[when("the workspace is type-checked")]
fn when_type_checked(world: &mut LangWorld) {
    world.diagnostics = check_types(&world.workspace);
}

#[when("inlay hints for the file are requested")]
fn when_inlay_hints(world: &mut LangWorld) {
    world.hints = inlay_hints(&world.workspace, &world.path);
}

/// The aggregated finding set (parse + type findings, with inline
/// `---@allow`-style lint levels resolved) — what every transport publishes.
#[when("diagnostics are collected")]
fn when_collected(world: &mut LangWorld) {
    world.diagnostics = all_findings(&world.workspace);
}

#[then(regex = r#"^diagnostic "([^"]+)" is reported at the argument "([^"]+)"$"#)]
fn then_diagnostic_at_arg(world: &mut LangWorld, code: String, arg: String) {
    let source = world.workspace.file(&world.path).expect("file mounted");
    let needle = source.source.find(&arg).expect("argument text present");
    let hit = world
        .diagnostics
        .iter()
        .any(|(_, d)| d.code == code && spans_contains(d, needle as u32, arg.len()));
    assert!(
        hit,
        "expected {code} at argument `{arg}` (offset {needle}); got {:?}",
        world.diagnostics
    );
}

#[then(regex = r#"^diagnostic "([^"]+)" is reported$"#)]
fn then_diagnostic_code(world: &mut LangWorld, code: String) {
    let hit = world.diagnostics.iter().any(|(_, d)| d.code == code);
    assert!(hit, "expected {code}; got {:?}", world.diagnostics);
}

#[then(regex = r"^(\d+) diagnostic(?:s)? (?:is|are) reported$")]
fn then_diagnostic_count(world: &mut LangWorld, count: usize) {
    assert_eq!(
        world.diagnostics.len(),
        count,
        "diagnostics: {:?}",
        world.diagnostics
    );
}

#[then("no diagnostics are reported")]
fn then_no_diagnostics(world: &mut LangWorld) {
    assert!(
        world.diagnostics.is_empty(),
        "expected none; got {:?}",
        world.diagnostics
    );
}

#[then(regex = r#"^an inlay hint "([^"]+)" follows "([^"]+)"$"#)]
fn then_inlay_after(world: &mut LangWorld, label: String, anchor: String) {
    let source = &world.workspace.file(&world.path).expect("file mounted").source;
    let anchor_end = source.find(&anchor).map(|i| i + anchor.len());
    let hit = world.hints.iter().any(|h| {
        h.label == label && anchor_end.is_none_or(|end| h.offset as usize == end)
    });
    assert!(
        hit,
        "expected hint `{label}` after `{anchor}`; got {:?}",
        world.hints
    );
}

#[then("no inlay hints are returned")]
fn then_no_hints(world: &mut LangWorld) {
    assert!(world.hints.is_empty(), "expected none; got {:?}", world.hints);
}

#[then(regex = r#"^the type of local "([^"]+)" is "([^"]+)"$"#)]
fn then_local_type(world: &mut LangWorld, local: String, expected: String) {
    use dcs_lua_syntax::ast::StatKind;
    let entry = world.workspace.file(&world.path).expect("file mounted");
    let ast = &entry.parsed.ast;
    // Find the `local <local> = <init>` statement and infer its initializer.
    let value = ast.stats.iter().find_map(|stat| {
        let StatKind::LocalAssign { names, values } = &stat.kind else {
            return None;
        };
        let position = names.iter().position(|n| n.text == local)?;
        values.get(position).copied()
    });
    let value = value.unwrap_or_else(|| panic!("no `local {local}` with an initializer"));
    let ty = infer_type(&world.workspace, &world.path, value);
    assert_eq!(ty.render(), expected, "inferred {ty:?}");
}

/// Whether a diagnostic's span overlaps `[start, start+len)`.
fn spans_contains(d: &dcs_lua_syntax::Diagnostic, start: u32, len: usize) -> bool {
    let end = start + len as u32;
    d.span.start >= start && d.span.start < end
}

#[tokio::main]
async fn main() {
    LangWorld::run("tests/features").await;
}
