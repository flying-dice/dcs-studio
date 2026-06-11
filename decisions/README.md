# decisions/ — architecture decision records

One record per resolved fork. Before changing a rule a record pins, read it
in full. Format per record: Context, Decision, Consequences.

| ADR | Decision |
| --- | --- |
| [001](001-hand-rolled-syntax.md) | Hand-rolled lexer and parser; full_moon and tree-sitter rejected |
| [002](002-wasm-only-edge.md) | Single wasm edge (`IdeSession`); no stdio LSP server |
| [003](003-luals-compatible-annotations.md) | LuaLS/EmmyLua-compatible annotation dialect |
| [004](004-lua-51-source-dialect.md) | Lua 5.1 source dialect; LuaJIT extensions excluded |
