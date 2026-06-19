//! The tower-lsp server over `dcs-lua-lsp-core`.
//!
//! `initialize` records the workspace `rootUri`; `initialized` walks it for
//! Lua sources so workspace-wide diagnostics publish from boot. Edits arrive
//! as full-document sync. Positions are UTF-16 (the protocol default),
//! derived from the engine's byte spans at this edge.

use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use dcs_lua_lsp_core::workspace::Workspace;
use dcs_lua_lsp_core::{
    DocumentSymbol as CoreSymbol, SymbolKind as CoreSymbolKind, file_findings, findings_by_file,
};
use dcs_lua_syntax::{LineIndex, Severity, Span};
use tower_lsp::jsonrpc::Result;
use tower_lsp::lsp_types::{
    Diagnostic, DiagnosticSeverity, DidChangeTextDocumentParams, DidCloseTextDocumentParams,
    DidOpenTextDocumentParams, DocumentSymbol, DocumentSymbolParams, DocumentSymbolResponse,
    FoldingRange, FoldingRangeParams, FoldingRangeProviderCapability, GotoDefinitionParams,
    GotoDefinitionResponse, Hover, HoverContents, HoverParams, HoverProviderCapability,
    InitializeParams, InitializeResult, InitializedParams, InlayHint, InlayHintKind,
    InlayHintLabel, InlayHintParams, Location, MarkupContent, MarkupKind, NumberOrString, OneOf,
    Position, Range, ReferenceParams, RenameParams, ServerCapabilities, ServerInfo, SymbolKind,
    TextDocumentSyncCapability, TextDocumentSyncKind, TextEdit, Url, WorkspaceEdit,
};
use tower_lsp::{Client, LanguageServer, LspService, Server};

pub async fn serve() {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    let (service, socket) = LspService::new(|client| Backend {
        client,
        workspace: Mutex::new(Workspace::new()),
        root: Mutex::new(None),
        walked: Mutex::new(std::collections::HashSet::new()),
    });
    Server::new(stdin, stdout, socket).serve(service).await;
}

struct Backend {
    client: Client,
    workspace: Mutex<Workspace>,
    root: Mutex<Option<PathBuf>>,
    /// Files mounted by the initialize walk. A `didClose` on anything
    /// else (client-pushed, e.g. the IDE proxying a file delete) unmounts
    /// it; walked files outlive editors so workspace findings persist.
    walked: Mutex<std::collections::HashSet<String>>,
}

impl Backend {
    /// Update one document and collect the publish set while the lock is
    /// held; the awaits happen outside the lock.
    fn set_and_collect(&self, path: &str, text: &str) -> Vec<(Url, Vec<Diagnostic>)> {
        let mut workspace = self.workspace.lock().unwrap_or_else(PoisonError::into_inner);
        workspace.set_source(path, text);
        // `file_findings` is the shared finding set (parse + type + future);
        // this edge only maps it to LSP wire diagnostics. A cross-file edit
        // may leave a stale finding in another file until that file is next
        // published — consistent with this server's per-file publish
        // granularity (the boot walk covers the whole workspace).
        collect_file_diagnostics(&workspace, path, &file_findings(&workspace, path))
            .map(|payload| vec![payload])
            .unwrap_or_default()
    }

    async fn publish(&self, batches: Vec<(Url, Vec<Diagnostic>)>) {
        for (uri, diagnostics) in batches {
            tracing::debug!(%uri, count = diagnostics.len(), "publishDiagnostics");
            self.client
                .publish_diagnostics(uri, diagnostics, None)
                .await;
        }
    }
}

#[tower_lsp::async_trait]
impl LanguageServer for Backend {
    async fn initialize(&self, params: InitializeParams) -> Result<InitializeResult> {
        if let Some(root_uri) = params.root_uri
            && let Ok(path) = root_uri.to_file_path()
        {
            tracing::info!(root = %path.display(), "initialize");
            *self.root.lock().unwrap_or_else(PoisonError::into_inner) = Some(path);
        } else {
            tracing::info!(root = "none", "initialize (no rootUri)");
        }
        Ok(InitializeResult {
            server_info: Some(ServerInfo {
                name: "lua-analyzer".to_string(),
                version: Some(env!("CARGO_PKG_VERSION").to_string()),
            }),
            capabilities: ServerCapabilities {
                text_document_sync: Some(TextDocumentSyncCapability::Kind(
                    TextDocumentSyncKind::FULL,
                )),
                document_symbol_provider: Some(OneOf::Left(true)),
                folding_range_provider: Some(FoldingRangeProviderCapability::Simple(true)),
                hover_provider: Some(HoverProviderCapability::Simple(true)),
                inlay_hint_provider: Some(OneOf::Left(true)),
                definition_provider: Some(OneOf::Left(true)),
                references_provider: Some(OneOf::Left(true)),
                rename_provider: Some(OneOf::Left(true)),
                ..ServerCapabilities::default()
            },
        })
    }

    async fn initialized(&self, _: InitializedParams) {
        // Mount the whole workspace so diagnostics cover unopened files.
        let root = self.root.lock().unwrap_or_else(PoisonError::into_inner).clone();
        let Some(root) = root else {
            tracing::warn!("initialized with no root — nothing to walk");
            return;
        };
        let files = dcs_studio_project::sources::collect(&root);
        tracing::info!(root = %root.display(), files = files.len(), "workspace walk");
        {
            let mut walked = self.walked.lock().unwrap_or_else(PoisonError::into_inner);
            for (path, _) in &files {
                walked.insert(path.clone());
            }
        }
        let batches = {
            let mut workspace = self.workspace.lock().unwrap_or_else(PoisonError::into_inner);
            for (path, text) in &files {
                workspace.set_source(path, text);
            }
            // Apply the project's `[lints.lua]` levels (absent/invalid manifest
            // → defaults); inline `---@allow`/`deny`/… directives still apply.
            workspace.set_lint_levels(dcs_lua_lsp_core::lints::levels_from_strings(
                &dcs_studio_project::manifest::lua_lint_levels(&root),
            ));
            // One shared aggregation for the whole walk, not one per file.
            let by_file = findings_by_file(&workspace);
            files
                .iter()
                .filter_map(|(path, _)| {
                    collect_file_diagnostics(
                        &workspace,
                        path,
                        by_file.get(path).map_or(&[], Vec::as_slice),
                    )
                })
                .collect::<Vec<_>>()
        };
        self.publish(batches).await;
    }

    async fn shutdown(&self) -> Result<()> {
        Ok(())
    }

    async fn did_open(&self, params: DidOpenTextDocumentParams) {
        let Some(path) = uri_path(&params.text_document.uri) else {
            return;
        };
        let batches = self.set_and_collect(&path, &params.text_document.text);
        self.publish(batches).await;
    }

    async fn did_change(&self, params: DidChangeTextDocumentParams) {
        let Some(path) = uri_path(&params.text_document.uri) else {
            return;
        };
        // FULL sync: the last change carries the whole document.
        let Some(change) = params.content_changes.into_iter().last() else {
            return;
        };
        let batches = self.set_and_collect(&path, &change.text);
        self.publish(batches).await;
    }

    async fn did_close(&self, params: DidCloseTextDocumentParams) {
        // Walk-mounted files stay (workspace findings outlive editors);
        // a client-pushed file closing means the client is done with it —
        // unmount and clear its findings, so deletes leave no ghosts.
        let Some(path) = uri_path(&params.text_document.uri) else {
            return;
        };
        if self.walked.lock().unwrap_or_else(PoisonError::into_inner).contains(&path) {
            return;
        }
        self.workspace
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove_source(&path);
        self.client
            .publish_diagnostics(params.text_document.uri, Vec::new(), None)
            .await;
    }

    async fn document_symbol(
        &self,
        params: DocumentSymbolParams,
    ) -> Result<Option<DocumentSymbolResponse>> {
        let Some(path) = uri_path(&params.text_document.uri) else {
            return Ok(None);
        };
        let workspace = self.workspace.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(entry) = workspace.file(&path) else {
            return Ok(None);
        };
        let index = LineIndex::new(&entry.source);
        let symbols = dcs_lua_lsp_core::document_symbols(&workspace, &path)
            .into_iter()
            .map(|symbol| convert_symbol(symbol, &entry.source, &index))
            .collect();
        Ok(Some(DocumentSymbolResponse::Nested(symbols)))
    }

    async fn hover(&self, params: HoverParams) -> Result<Option<Hover>> {
        let position_params = params.text_document_position_params;
        let Some(path) = uri_path(&position_params.text_document.uri) else {
            return Ok(None);
        };
        let workspace = self.workspace.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(entry) = workspace.file(&path) else {
            return Ok(None);
        };
        let offset = offset_of(&entry.source, position_params.position);
        let Some(card) = dcs_lua_lsp_core::hover(&workspace, &path, offset) else {
            return Ok(None);
        };
        // Emit the signature as a fenced ```lua block plus the doc body — the
        // same MarkupContent convention rust-analyzer uses, so the IDE renders
        // every hosted server's hover the same way and never reconstructs a
        // title from the markdown.
        let value = if card.body.is_empty() {
            format!("```lua\n{}\n```", card.title)
        } else {
            format!("```lua\n{}\n```\n\n{}", card.title, card.body)
        };
        Ok(Some(Hover {
            contents: HoverContents::Markup(MarkupContent {
                kind: MarkupKind::Markdown,
                value,
            }),
            range: None,
        }))
    }

    async fn folding_range(&self, params: FoldingRangeParams) -> Result<Option<Vec<FoldingRange>>> {
        let Some(path) = uri_path(&params.text_document.uri) else {
            return Ok(None);
        };
        let workspace = self.workspace.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(entry) = workspace.file(&path) else {
            return Ok(None);
        };
        let index = LineIndex::new(&entry.source);
        let ranges = dcs_lua_lsp_core::folding_ranges(&workspace, &path)
            .into_iter()
            .filter_map(|span| {
                let (start_line, _) = index.line_col(span.start);
                let (end_line, _) = index.line_col(span.end);
                // Single-line spans fold nothing.
                (end_line > start_line).then(|| FoldingRange {
                    start_line: start_line - 1,
                    end_line: end_line - 1,
                    ..FoldingRange::default()
                })
            })
            .collect();
        Ok(Some(ranges))
    }

    async fn inlay_hint(&self, params: InlayHintParams) -> Result<Option<Vec<InlayHint>>> {
        let Some(path) = uri_path(&params.text_document.uri) else {
            return Ok(None);
        };
        let workspace = self.workspace.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(entry) = workspace.file(&path) else {
            return Ok(None);
        };
        let index = LineIndex::new(&entry.source);
        let hints = dcs_lua_lsp_core::inlay_hints(&workspace, &path)
            .into_iter()
            .map(|hint| InlayHint {
                position: position(&entry.source, &index, hint.offset),
                label: InlayHintLabel::String(hint.label),
                kind: Some(InlayHintKind::TYPE),
                text_edits: None,
                tooltip: None,
                padding_left: Some(true),
                padding_right: None,
                data: None,
            })
            .collect();
        Ok(Some(hints))
    }

    async fn goto_definition(
        &self,
        params: GotoDefinitionParams,
    ) -> Result<Option<GotoDefinitionResponse>> {
        let position = params.text_document_position_params;
        let Some(path) = uri_path(&position.text_document.uri) else {
            return Ok(None);
        };
        let workspace = self.workspace.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(entry) = workspace.file(&path) else {
            return Ok(None);
        };
        let offset = offset_of(&entry.source, position.position);
        let Some(location) = dcs_lua_lsp_core::definition(&workspace, &path, offset) else {
            return Ok(None);
        };
        Ok(to_lsp_location(&workspace, &location).map(GotoDefinitionResponse::Scalar))
    }

    async fn references(&self, params: ReferenceParams) -> Result<Option<Vec<Location>>> {
        let position = params.text_document_position;
        let Some(path) = uri_path(&position.text_document.uri) else {
            return Ok(None);
        };
        let workspace = self.workspace.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(entry) = workspace.file(&path) else {
            return Ok(None);
        };
        let offset = offset_of(&entry.source, position.position);
        let locations = dcs_lua_lsp_core::references(&workspace, &path, offset)
            .iter()
            .filter_map(|location| to_lsp_location(&workspace, location))
            .collect();
        Ok(Some(locations))
    }

    async fn rename(&self, params: RenameParams) -> Result<Option<WorkspaceEdit>> {
        let position = params.text_document_position;
        let Some(path) = uri_path(&position.text_document.uri) else {
            return Ok(None);
        };
        let workspace = self.workspace.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(entry) = workspace.file(&path) else {
            return Ok(None);
        };
        let offset = offset_of(&entry.source, position.position);
        // A refused rename (invalid name, nothing to rename) is surfaced to
        // the editor as an error so it can show the message, not swallowed.
        match dcs_lua_lsp_core::rename(&workspace, &path, offset, &params.new_name) {
            Ok(edit) => Ok(Some(to_lsp_workspace_edit(&workspace, &edit))),
            Err(error) => Err(tower_lsp::jsonrpc::Error::invalid_params(error.message)),
        }
    }
}

/// An engine [`Location`](dcs_lua_lsp_core::Location) → an LSP `Location` with
/// a UTF-16 range, read from the TARGET file's source (which may differ from
/// the queried file for a cross-file global).
fn to_lsp_location(workspace: &Workspace, location: &dcs_lua_lsp_core::Location) -> Option<Location> {
    let entry = workspace.file(&location.path)?;
    let uri = Url::from_file_path(&location.path).ok()?;
    let index = LineIndex::new(&entry.source);
    Some(Location {
        uri,
        range: span_range(&entry.source, &index, location.span),
    })
}

/// An engine [`WorkspaceEdit`](dcs_lua_lsp_core::WorkspaceEdit) → an LSP
/// `WorkspaceEdit`, grouping the per-occurrence edits by file URI with
/// UTF-16 ranges. An edit whose file is no longer mounted is dropped.
fn to_lsp_workspace_edit(
    workspace: &Workspace,
    edit: &dcs_lua_lsp_core::WorkspaceEdit,
) -> WorkspaceEdit {
    let mut changes: std::collections::HashMap<Url, Vec<TextEdit>> =
        std::collections::HashMap::new();
    for text_edit in &edit.edits {
        let Some(entry) = workspace.file(&text_edit.path) else {
            continue;
        };
        let Ok(uri) = Url::from_file_path(&text_edit.path) else {
            continue;
        };
        let index = LineIndex::new(&entry.source);
        changes.entry(uri).or_default().push(TextEdit {
            range: span_range(&entry.source, &index, text_edit.span),
            new_text: text_edit.new_text.clone(),
        });
    }
    WorkspaceEdit {
        changes: Some(changes),
        ..WorkspaceEdit::default()
    }
}

fn uri_path(uri: &Url) -> Option<String> {
    uri.to_file_path()
        .ok()
        .map(|path| path.display().to_string())
}

/// The LSP publish payload for one file: map the shared finding set
/// ([`file_findings`] / [`findings_by_file`]) to wire diagnostics with
/// UTF-16 ranges. This edge owns the wire conversion only — never which
/// findings exist.
fn collect_file_diagnostics(
    workspace: &Workspace,
    path: &str,
    findings: &[dcs_lua_syntax::Diagnostic],
) -> Option<(Url, Vec<Diagnostic>)> {
    let entry = workspace.file(path)?;
    let uri = Url::from_file_path(path).ok()?;
    let index = LineIndex::new(&entry.source);
    let diagnostics = findings
        .iter()
        .map(|diagnostic| Diagnostic {
            range: span_range(&entry.source, &index, diagnostic.span),
            severity: Some(match diagnostic.severity {
                Severity::Error => DiagnosticSeverity::ERROR,
                Severity::Warning => DiagnosticSeverity::WARNING,
                Severity::Info => DiagnosticSeverity::INFORMATION,
            }),
            code: Some(NumberOrString::String(diagnostic.code.to_string())),
            source: Some("dcs-lua".to_string()),
            message: diagnostic.message.clone(),
            ..Diagnostic::default()
        })
        .collect();
    Some((uri, diagnostics))
}

fn span_range(src: &str, index: &LineIndex, span: Span) -> Range {
    Range {
        start: position(src, index, span.start),
        end: position(src, index, span.end),
    }
}

/// Engine byte offset → LSP `Position` (0-based line, UTF-16 column).
fn position(src: &str, index: &LineIndex, offset: u32) -> Position {
    let offset = offset.min(src.len() as u32);
    let (line, byte_col) = index.line_col(offset);
    let line_start = (offset - (byte_col - 1)) as usize;
    let character = src
        .get(line_start..offset as usize)
        .map_or(byte_col - 1, |prefix| prefix.encode_utf16().count() as u32);
    Position::new(line - 1, character)
}

/// LSP `Position` (0-based line, UTF-16 column) → engine byte offset —
/// the inverse of [`position`]. Out-of-range lines and columns clamp to
/// the line end / source end, mirroring the protocol's leniency.
fn offset_of(src: &str, position: Position) -> u32 {
    let mut line_start = 0usize;
    for _ in 0..position.line {
        match src[line_start..].find('\n') {
            Some(newline) => line_start += newline + 1,
            None => return src.len() as u32,
        }
    }
    let line_end = src[line_start..]
        .find('\n')
        .map_or(src.len(), |newline| line_start + newline);
    let line = &src[line_start..line_end];
    let mut units = 0u32;
    for (byte, ch) in line.char_indices() {
        if units >= position.character {
            return (line_start + byte) as u32;
        }
        units += ch.len_utf16() as u32;
    }
    line_end as u32
}

fn convert_symbol(symbol: CoreSymbol, src: &str, index: &LineIndex) -> DocumentSymbol {
    #[allow(deprecated)] // `deprecated` field is part of the wire struct.
    DocumentSymbol {
        name: if symbol.name.is_empty() {
            "(anonymous)".to_string()
        } else {
            symbol.name
        },
        detail: None,
        kind: match symbol.kind {
            CoreSymbolKind::Function => SymbolKind::FUNCTION,
            CoreSymbolKind::Variable => SymbolKind::VARIABLE,
        },
        tags: None,
        deprecated: None,
        range: span_range(src, index, symbol.span),
        selection_range: span_range(src, index, symbol.selection),
        children: Some(
            symbol
                .children
                .into_iter()
                .map(|child| convert_symbol(child, src, index))
                .collect(),
        ),
    }
}
