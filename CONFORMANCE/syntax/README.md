# syntax/ — parse and recovery cases

Accept cases are plain `name.lua` files that MUST parse with zero
diagnostics.

Reject cases are `name.reject` (Lua source containing exactly one violation)
plus `name.reject.expected` — a one-line error category in prose, e.g.
`unterminated block: 'end' expected`. The parser MUST emit a diagnostic in
the `LUA-E1xx` range, and MUST still return a tree (SPEC.md §3).
