//! `dcs-studio-cli lsp` — the genuine Language Server Protocol edge over
//! `dcs-lua-lsp-core` (decisions/005). Any LSP client works: editors, the
//! IDE's backend host, LLM agents.
//!
//! initialize walks the workspace root for Lua sources, so workspace-wide
//! diagnostics publish from boot; edits arrive as full-document sync.
//! Positions are UTF-16 (the protocol default), derived from the engine's
//! byte spans at this edge.

use std::path::PathBuf;
use std::sync::Mutex;

use dcs_lua_lsp_core::workspace::Workspace;
use dcs_lua_lsp_core::{DocumentSymbol as CoreSymbol, SymbolKind as CoreSymbolKind};
use dcs_lua_syntax::{LineIndex, Severity, Span};
use tower_lsp::jsonrpc::Result;
use tower_lsp::lsp_types::{
    Diagnostic, DiagnosticSeverity, DidChangeTextDocumentParams, DidCloseTextDocumentParams,
    DidOpenTextDocumentParams, DocumentSymbol, DocumentSymbolParams, DocumentSymbolResponse,
    FoldingRange, FoldingRangeParams, FoldingRangeProviderCapability, InitializeParams,
    InitializeResult, InitializedParams, NumberOrString, OneOf, Position, Range,
    ServerCapabilities, ServerInfo, SymbolKind, TextDocumentSyncCapability, TextDocumentSyncKind,
    Url,
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
        let mut workspace = self.workspace.lock().expect("workspace lock");
        workspace.set_source(path, text);
        collect_file_diagnostics(&workspace, path)
            .map(|payload| vec![payload])
            .unwrap_or_default()
    }

    async fn publish(&self, batches: Vec<(Url, Vec<Diagnostic>)>) {
        for (uri, diagnostics) in batches {
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
            *self.root.lock().expect("root lock") = Some(path);
        }
        Ok(InitializeResult {
            server_info: Some(ServerInfo {
                name: "dcs-studio-cli".to_string(),
                version: Some(env!("CARGO_PKG_VERSION").to_string()),
            }),
            capabilities: ServerCapabilities {
                text_document_sync: Some(TextDocumentSyncCapability::Kind(
                    TextDocumentSyncKind::FULL,
                )),
                document_symbol_provider: Some(OneOf::Left(true)),
                folding_range_provider: Some(FoldingRangeProviderCapability::Simple(true)),
                ..ServerCapabilities::default()
            },
        })
    }

    async fn initialized(&self, _: InitializedParams) {
        // Mount the whole workspace so diagnostics cover unopened files.
        let root = self.root.lock().expect("root lock").clone();
        let Some(root) = root else { return };
        let files = crate::sources::collect(&root);
        {
            let mut walked = self.walked.lock().expect("walked lock");
            for (path, _) in &files {
                walked.insert(path.clone());
            }
        }
        let batches = {
            let mut workspace = self.workspace.lock().expect("workspace lock");
            for (path, text) in &files {
                workspace.set_source(path, text);
            }
            files
                .iter()
                .filter_map(|(path, _)| collect_file_diagnostics(&workspace, path))
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
        if self.walked.lock().expect("walked lock").contains(&path) {
            return;
        }
        self.workspace
            .lock()
            .expect("workspace lock")
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
        let workspace = self.workspace.lock().expect("workspace lock");
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

    async fn folding_range(&self, params: FoldingRangeParams) -> Result<Option<Vec<FoldingRange>>> {
        let Some(path) = uri_path(&params.text_document.uri) else {
            return Ok(None);
        };
        let workspace = self.workspace.lock().expect("workspace lock");
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
}

fn uri_path(uri: &Url) -> Option<String> {
    uri.to_file_path()
        .ok()
        .map(|path| path.display().to_string())
}

fn collect_file_diagnostics(workspace: &Workspace, path: &str) -> Option<(Url, Vec<Diagnostic>)> {
    let entry = workspace.file(path)?;
    let uri = Url::from_file_path(path).ok()?;
    let index = LineIndex::new(&entry.source);
    let diagnostics = entry
        .parsed
        .diagnostics
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
