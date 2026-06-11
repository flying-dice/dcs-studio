# 001 — Hand-rolled lexer and parser

Affects: `SPEC.md §2`, `SPEC.md §3`, `crates/dcs-lua-syntax`.

## Context

Three parser strategies were on the table: `full_moon` (existing Lua CST
crate with `parse_fallible`), `tree-sitter-lua` (incremental,
error-tolerant), and a hand-rolled recursive-descent parser in the
pseudoscript style.

## Decision

Hand-roll both the lexer and the parser.

- Trivia handling must be explicit: `---` doc-comment runs are the carrier
  for the annotation dialect (`SPEC.md §4`) and must attach to the following
  declaration. full_moon keeps comments as token trivia but its attachment
  ergonomics are not ours to tune; tree-sitter detaches comments entirely.
- Error recovery must be steerable per production (`end`-matching, statement
  resync) to honour total parsing (`SPEC.md §3`).
- Lua 5.1's grammar is small and frozen; the cost is bounded and paid once.
- The team pattern is proven: pseudoscript ships the same shape.

## Consequences

- Recovery quality is owned, and earned through `CONFORMANCE/syntax/` reject
  cases plus the parser-totality property test.
- No third-party grammar to track; 5.2/5.3 features stay out by construction
  (decisions/004).
- More upfront code than wrapping full_moon; the conformance suite is the
  guard rail.
