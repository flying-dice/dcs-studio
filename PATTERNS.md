# PATTERNS.md — implementation idioms

Guiding constraints, then per-crate patterns. Cross-references: `SPEC.md §N`,
`decisions/00N`.

## Guiding constraints

1. **Pure core, I/O at the edge.** `dcs-lua-syntax` and `dcs-lua-lsp-core`
   are pure functions over strings and workspaces — no filesystem, clock,
   threads, or network. All I/O and session state live in `dcs-lua-ide`.
2. **One core, one edge.** Every capability is implemented once in
   `lsp-core`; `dcs-lua-ide` is a thin typed adapter. Anything
   dcs-studio-specific stays out of the core (decisions/002).
3. **Diagnostics as data.** Analysis is total (`SPEC.md §3`): value +
   diagnostics, never a panic on user input. `Result` only where the engine
   itself can fail (session misuse), never for malformed Lua.
4. **Incremental-friendly, not incremental yet.** Core queries are pure and
   per-file keyed, so memoisation slots underneath without rewriting logic.

## dcs-lua-syntax

Arena AST: nodes in `Vec<T>` addressed by `u32` newtype ids, not `Box`/`Rc`
trees. `Copy`, cache-friendly, serialisable, no borrow gymnastics.

```rust
struct ExprId(u32);
struct Arena { exprs: Vec<Expr>, stats: Vec<Stat>, blocks: Vec<Block> }
```

Total parsing: every parse returns `Parsed { chunk, diagnostics }`. On an
unexpected token: record a diagnostic, resynchronise to a statement boundary
(`end`-aware), continue. A forward-progress guard skips any token that starts
no statement, so the loop can never spin.

One lexer pass, two surfaces: the conformance token stream and full-fidelity
trivia (comments + blank-line gaps). `---` doc comments are trivia in
Phase 1; the annotation parser (Phase 3) reads them from trivia, the
statement grammar never sees them.

Spans are byte offsets (`Span { start: u32, end: u32 }`); line/col derive
via `LineIndex` only at the rendering edge.

## dcs-lua-lsp-core

Stateless per query: `fn diagnostics(ws: &Workspace) -> Vec<Diagnostic>`,
`fn complete(ws: &Workspace, path: &str, offset: u32) -> Vec<CompletionItem>`.
The `Workspace` is passed in; session state lives at the edge.

## dcs-lua-ide

`IdeSession` holds the workspace: `mount(files, rules)`, `set_source`,
`remove_source` mutate; query ports delegate to `lsp-core`. The boundary is
typed with `tsify` — Rust DTOs are the source of truth, wasm-bindgen emits
the `.d.ts`, values cross as objects.

## Conformance harness

Each layer's goldens run from a golden-diffing test (`dcs-lua-syntax`'s
`tests/conformance.rs`) that globs `CONFORMANCE/<layer>/` and diffs rendered
output against the golden, mirroring pseudoscript's harness.

## Type-layer parity harness (Cucumber)

The type layer (annotations, inference, `param-type-mismatch`, inlay hints) is covered by
a real Cucumber suite in `dcs-lua-lsp-core` (`tests/parity.rs`, `harness =
false`; `.feature` files under `tests/features/`). Scenarios are authored from
lua-language-server's `test/` categories (type_inference, diagnostics,
inlay_hint, crossfile) but scoped to the **DCS Lua 5.1 dialect** — the cloned
LuaLS repo under `reference/` (gitignored) is a read-only reference, never a
dependency. Run with `cargo test -p dcs-lua-lsp-core --test parity`.
