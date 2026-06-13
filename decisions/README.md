# decisions/ — architecture decision records

One record per resolved fork. Before changing a rule a record pins, read it
in full. Format per record: Context, Decision, Consequences.

| ADR | Decision |
| --- | --- |
| [001](001-hand-rolled-syntax.md) | Hand-rolled lexer and parser; full_moon and tree-sitter rejected |
| [002](002-wasm-only-edge.md) | Single wasm edge (`IdeSession`); no stdio LSP server |
| [003](003-luals-compatible-annotations.md) | LuaLS/EmmyLua-compatible annotation dialect |
| [004](004-lua-51-source-dialect.md) | Lua 5.1 source dialect; LuaJIT extensions excluded |
| [005](005-stdio-lsp-edge.md) | dcs-studio-cli (LSP + MCP + init over stdio) + backend IPC host; supersedes 002 (wasm demoted to browser fallback) |
| [006](006-lua-formatter-house-style.md) | In-house deterministic Lua formatter (`dcs-lua-fmt`) and its house style; StyLua rejected |
