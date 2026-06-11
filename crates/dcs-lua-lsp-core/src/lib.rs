//! dcs-lua-lsp-core — transport-neutral language queries.
//!
//! Pure functions: `workspace + position -> LSP-shaped value`. Session
//! state lives at the edge (`dcs-lua-ide`); nothing here does I/O.
//!
//! Phase 1 scope: diagnostics, document symbols, folding ranges. The
//! resolution-backed queries (completion, hover, definition) land with the
//! model crate (plan Phase 2).

pub mod analysis;
pub mod fold;
pub mod symbols;
pub mod workspace;

pub use analysis::all_findings;
pub use fold::folding_ranges;
pub use symbols::{DocumentSymbol, SymbolKind, document_symbols};
pub use workspace::{FileEntry, Workspace};
