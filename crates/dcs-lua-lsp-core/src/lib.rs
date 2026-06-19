//! dcs-lua-lsp-core — transport-neutral language queries.
//!
//! Pure functions: `workspace + position -> LSP-shaped value`. Session
//! state lives at the edge (`dcs-lua-ide`); nothing here does I/O.
//!
//! Phase 1 shipped diagnostics, document symbols, and folding ranges.
//! Phase 2 (resolution) lands here slice by slice: hover is the first —
//! identifier resolution (innermost scope → file globals → workspace
//! globals), doc-comment bodies, and shallow initializer-inferred types.

// Test code is exempt from the production safety lints — indexing into
// known-shape fixtures and `panic!` on bad setup are idiomatic there.
#![cfg_attr(test, allow(clippy::indexing_slicing, clippy::panic, clippy::print_stderr))]

pub mod analysis;
pub mod annot;
pub mod assignable;
pub mod check;
pub mod definition;
pub mod fold;
pub mod hover;
pub mod infer;
pub mod inlay;
pub mod lints;
pub mod operands;
pub mod param_infer;
pub mod references;
pub mod rename;
pub mod resolve;
pub mod symbols;
pub mod ty_table;
pub mod workspace;

pub use analysis::{all_findings, file_findings, findings_by_file};
pub use assignable::assignable;
pub use check::check_types;
pub use definition::{Location, definition};
pub use fold::folding_ranges;
pub use hover::{HoverInfo, hover};
pub use infer::infer_type;
pub use inlay::{InlayHint, inlay_hints};
pub use lints::LintLevel;
pub use references::references;
pub use rename::{RenameError, TextEdit, WorkspaceEdit, rename};
pub use symbols::{DocumentSymbol, SymbolKind, document_symbols};
pub use ty_table::TypeTable;
pub use workspace::{FileEntry, Workspace};
