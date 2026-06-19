#![cfg_attr(test, allow(clippy::indexing_slicing, clippy::panic, clippy::print_stderr))] // test code exempt; unwrap/expect/dbg via clippy.toml

//! dcs-lua-ide — the wasm `IdeSession` edge over the engine. Its generated
//! bindings were the IDE's browser-mode language path until issue #32 retired
//! that path; the crate remains the engine's wasm-bindgen surface.
//!
//! One crate, one wasm artifact, one surface. The session holds the
//! workspace (the host pushes sources in through `mount` / `set_source` /
//! `remove_source`; the engine never touches a filesystem) and answers
//! every query by delegating to `dcs-lua-lsp-core`.
//!
//! The boundary is typed: the DTOs below derive [`tsify_next::Tsify`], so
//! wasm-bindgen emits the real TS interfaces and values cross as objects —
//! no hand-written TS, no `JSON.parse` (decisions/002).

use dcs_lua_lsp_core::workspace::{ProfileRule as CoreProfileRule, Workspace};
use dcs_lua_lsp_core::{DocumentSymbol as CoreSymbol, SymbolKind};
use dcs_lua_syntax::span::LineIndex;
use serde::{Deserialize, Serialize};
use tsify_next::Tsify;
use wasm_bindgen::prelude::*;

// ===========================================================================
// Boundary DTOs — the typed contract the IDE consumes.
// ===========================================================================

/// One workspace source — the file-system port's unit.
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct SourceFile {
    pub path: String,
    pub text: String,
}

/// Maps workspace files to a DCS environment profile by glob (SPEC.md §5).
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct ProfileRule {
    pub glob: String,
    pub profile: String,
}

/// One finding: byte span plus 1-based line/column endpoints, so the
/// editor places squiggles without re-indexing the source.
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct Diagnostic {
    pub path: String,
    /// `"error" | "warning" | "info"`.
    pub severity: String,
    /// Stable code from the SPEC.md §3.1 registry.
    pub code: String,
    /// Article URL the code resolves to; empty when none exists.
    pub code_description: String,
    pub message: String,
    pub start: u32,
    pub end: u32,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
}

/// One outline entry; `kind` is `"function" | "variable"`.
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct DocumentSymbol {
    pub name: String,
    pub kind: String,
    pub start: u32,
    pub end: u32,
    pub selection_start: u32,
    pub selection_end: u32,
    pub children: Vec<DocumentSymbol>,
}

/// One foldable region, in byte offsets; the editor folds by line.
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct FoldingRange {
    pub start: u32,
    pub end: u32,
}

/// One inferred-type inlay hint: a `: <type>` label drawn as ghost text
/// after the byte `offset` (the end of the bound name).
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct InlayHint {
    pub offset: u32,
    pub label: String,
    /// LSP inlay-hint kind; currently always `"Type"`.
    pub kind: String,
}

/// One completion suggestion (Phase 2; the port exists so the contract is
/// stable from day one).
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct CompletionItem {
    pub label: String,
    pub kind: String,
    pub detail: String,
}

/// Markdown hover card (Phase 2).
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct Hover {
    pub title: String,
    pub body: String,
}

/// A go-to-definition target (Phase 2).
#[derive(Debug, Clone, Serialize, Deserialize, Tsify)]
#[tsify(into_wasm_abi, from_wasm_abi)]
pub struct Location {
    pub path: String,
    pub start: u32,
    pub end: u32,
}

// ===========================================================================
// The session.
// ===========================================================================

/// The wasm-bindgen language engine session. JavaScript drives it through two ports:
/// the file system pushes sources in, the editor pulls answers out.
#[wasm_bindgen]
#[derive(Default)]
pub struct IdeSession {
    workspace: Workspace,
}

#[wasm_bindgen]
impl IdeSession {
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new() -> Self {
        #[cfg(target_arch = "wasm32")]
        console_error_panic_hook::set_once();
        Self::default()
    }

    /// Seed the session with the workspace's Lua sources and profile rules.
    /// Wholesale: any previously mounted workspace is replaced, so opening
    /// a different project never leaks files across sessions.
    pub fn mount(&mut self, files: Vec<SourceFile>, rules: Vec<ProfileRule>) {
        self.workspace = Workspace::new();
        self.workspace.set_profile_rules(
            rules
                .into_iter()
                .map(|rule| CoreProfileRule {
                    glob: rule.glob,
                    profile: rule.profile,
                })
                .collect(),
        );
        for file in files {
            self.workspace.set_source(&file.path, &file.text);
        }
    }

    /// Create or replace one source (editor edits, saves, generated files).
    pub fn set_source(&mut self, path: &str, text: &str) {
        self.workspace.set_source(path, text);
    }

    /// Drop one source (file deleted or regenerated away).
    pub fn remove_source(&mut self, path: &str) {
        self.workspace.remove_source(path);
    }

    /// All current findings across the mounted workspace: parse diagnostics
    /// plus the type-checker's `LUA-Txxx` findings, via the shared
    /// `all_findings` aggregation (the same one the CLI/MCP/LSP edges use).
    #[must_use]
    pub fn diagnostics(&self) -> Vec<Diagnostic> {
        let mut all: Vec<Diagnostic> = dcs_lua_lsp_core::all_findings(&self.workspace)
            .into_iter()
            .filter_map(|(path, diagnostic)| {
                let entry = self.workspace.file(&path)?;
                let index = LineIndex::new(&entry.source);
                Some(convert_diagnostic(&path, &diagnostic, &index))
            })
            .collect();
        all.sort_by(|a, b| (a.path.as_str(), a.start).cmp(&(b.path.as_str(), b.start)));
        all
    }

    /// The declaration outline of one file.
    #[must_use]
    pub fn document_symbols(&self, path: &str) -> Vec<DocumentSymbol> {
        dcs_lua_lsp_core::document_symbols(&self.workspace, path)
            .into_iter()
            .map(convert_symbol)
            .collect()
    }

    /// Foldable regions of one file.
    #[must_use]
    pub fn folding_ranges(&self, path: &str) -> Vec<FoldingRange> {
        dcs_lua_lsp_core::folding_ranges(&self.workspace, path)
            .into_iter()
            .map(|span| FoldingRange {
                start: span.start,
                end: span.end,
            })
            .collect()
    }

    /// Suggestions at a cursor offset. Phase 2 — empty until resolution
    /// lands; the port keeps the boundary contract stable.
    #[must_use]
    pub fn complete(&self, _path: &str, _offset: u32) -> Vec<CompletionItem> {
        Vec::new()
    }

    /// Hover card for the identifier at a byte offset: declaration kind
    /// and signature, the doc run above the declaration, and the shallow
    /// initializer-inferred type (lsp-core resolution).
    #[must_use]
    pub fn hover(&self, path: &str, offset: u32) -> Option<Hover> {
        dcs_lua_lsp_core::hover(&self.workspace, path, offset).map(|info| Hover {
            title: info.title,
            body: info.body,
        })
    }

    /// Definition site of the symbol at an offset. Phase 2.
    #[must_use]
    pub fn definition(&self, _path: &str, _offset: u32) -> Option<Location> {
        None
    }

    /// Inferred-type inlay hints for one file (lsp-core resolution).
    #[must_use]
    pub fn inlay_hints(&self, path: &str) -> Vec<InlayHint> {
        dcs_lua_lsp_core::inlay_hints(&self.workspace, path)
            .into_iter()
            .map(|hint| InlayHint {
                offset: hint.offset,
                label: hint.label,
                kind: hint.kind,
            })
            .collect()
    }
}

fn convert_diagnostic(
    path: &str,
    diagnostic: &dcs_lua_syntax::Diagnostic,
    index: &LineIndex,
) -> Diagnostic {
    let (start_line, start_col) = index.line_col(diagnostic.span.start);
    let (end_line, end_col) = index.line_col(diagnostic.span.end);
    Diagnostic {
        path: path.to_string(),
        severity: match diagnostic.severity {
            dcs_lua_syntax::Severity::Error => "error",
            dcs_lua_syntax::Severity::Warning => "warning",
            dcs_lua_syntax::Severity::Info => "info",
        }
        .to_string(),
        code: diagnostic.code.to_string(),
        code_description: diagnostic.code_description.to_string(),
        message: diagnostic.message.clone(),
        start: diagnostic.span.start,
        end: diagnostic.span.end,
        start_line,
        start_col,
        end_line,
        end_col,
    }
}

fn convert_symbol(symbol: CoreSymbol) -> DocumentSymbol {
    DocumentSymbol {
        name: symbol.name,
        kind: match symbol.kind {
            SymbolKind::Function => "function",
            SymbolKind::Variable => "variable",
        }
        .to_string(),
        start: symbol.span.start,
        end: symbol.span.end,
        selection_start: symbol.selection.start,
        selection_end: symbol.selection.end,
        children: symbol.children.into_iter().map(convert_symbol).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_round_trip_on_host() {
        let mut session = IdeSession::new();
        session.mount(
            vec![SourceFile {
                path: "main.lua".to_string(),
                text: "function f(\n".to_string(),
            }],
            vec![],
        );
        let diagnostics = session.diagnostics();
        assert!(!diagnostics.is_empty());
        assert!(diagnostics[0].code.starts_with("LUA-E"));
        assert_eq!(diagnostics[0].path, "main.lua");
        assert!(diagnostics[0].start_line >= 1);

        session.set_source("main.lua", "function f() end\n");
        assert!(session.diagnostics().is_empty());
        let symbols = session.document_symbols("main.lua");
        assert_eq!(symbols[0].name, "f");
        assert_eq!(symbols[0].kind, "function");
        assert!(!session.folding_ranges("main.lua").is_empty());

        // Hover over a documented local crosses the boundary intact.
        let documented = "--- Radio callsign.\nlocal callsign = \"Maverick\"\nprint(callsign)\n";
        session.set_source("main.lua", documented);
        let offset = documented.rfind("callsign").expect("use site") as u32;
        let hover = session.hover("main.lua", offset).expect("hover card");
        assert!(hover.title.contains("callsign"));
        assert!(hover.body.contains("Radio callsign."));
        assert!(session.hover("main.lua", 0).is_none());

        session.remove_source("main.lua");
        assert!(session.diagnostics().is_empty());
    }
}
