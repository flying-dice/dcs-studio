# 006 — In-house Lua formatter and its house style

Affects: `SPEC.md §7`, `crates/dcs-lua-fmt`, `crates/dcs-studio-cli` (`fmt`),
`crates/dcs-studio-project` (`[format]` manifest section), `CONFORMANCE/format/`.

## Context

Mission scripts deserve one canonical shape in the editor and in CI, with no
external tool to version-pin (StyLua rejected: a second parser with its own
dialect opinions, a native dependency to ship, and no reuse of our lossless
front-end). `crates/dcs-lua-syntax` already lexes full-fidelity trivia
(comments including `---` doc runs, exact long-bracket levels, blank-line
gaps) with byte spans, and parses totally — the formatter is a printer over
that front-end, not a second parser.

## Decision

Roll our own deterministic Lua 5.1 formatter in `crates/dcs-lua-fmt`:
`format(source, &FormatConfig)` and `format_range(...)`, exposed as
`dcs-studio-cli fmt [--check]` now and wired into the editor with issue #18.
Unparseable files come back `Err(diagnostics)`, never half-formatted.
Semantic preservation is enforced at runtime: the printed text is re-parsed
and structurally compared (spans ignored, short strings by decoded value)
against the input tree, and the multiset of comment texts must survive; on
any mismatch the input text is returned unchanged with the result's
`guard_tripped` flag raised. A guard trip is signalled, never an abort: the
CLI ships next to the editor and walks whole directories, so the earlier
`debug_assert!` abort was dropped outright in favour of the explicit flag —
the CLI prints a loud stderr warning naming the file, continues the walk
(so every affected file gets named), and folds the trip into a failing
exit code in both modes (in-place and `--check`): a trip is an internal
formatter bug leaving a file non-canonical, and a gate built on fmt must
go red, not green. The corpus property tests assert the flag stays false
(the same loudness the debug assert provided, without taking a format run
down).

Config lives in `dcs-studio.toml` under `[format]` (parsed by
`dcs-studio-project`, every field defaulted): `indent_width` (4),
`indent_style` (`"space"` | `"tab"`), `quote_style` (`"double"` |
`"single"`), `max_width` (100, in UTF-8 bytes; values below 20 clamp to 20), `trailing_comma`
(`"multiline"` | `"never"`).

### House style

| Rule | Choice | Example |
| --- | --- | --- |
| Indentation | 4 spaces per block level (configurable width/style) | `if x then` → body at 4 spaces |
| Line width | 100, measured in UTF-8 **bytes**, not display columns — a deterministic, cheap proxy (no Unicode width tables to version); non-ASCII text wraps early, which is the conservative direction. Lines break at the outermost breakable construct (table fields, call arguments — one per line); a line with nothing breakable may exceed the width | `f(\n    a,\n    b\n)` |
| Quotes | Double quotes preferred; a string whose content contains `"` keeps its original quotes; other escapes and all content bytes (non-ASCII included) are preserved verbatim; long-bracket strings are never touched | `'hi'` → `"hi"`, `'héllo'` → `"héllo"`, `'say "hi"'` stays |
| Long-bracket keys | A `[`/`]` index or table key whose key text itself starts with `[` (a long-bracket string) is padded with one space on each side so the brackets cannot fuse into a long-bracket opener | `t[ [[s]] ]`, `{ [ [[k]] ] = 1 }` |
| Tables: single vs multiline | The author's choice is respected: a table written on one line stays single-line while it fits and holds no comments; a table containing a newline stays multiline; over-width tables break | `{ 1, 2 }` stays; `{\n    1,\n}` stays |
| Tables: spacing | One space inside non-empty single-line braces; `{}` for empty | `{ a = 1, b = 2 }` |
| Tables: trailing comma | Multiline fields each end with `,` (config `"multiline"`, the default; `"never"` drops it); single-line tables never carry one | `{\n    a = 1,\n}` |
| Tables: `;` separators | Normalised to `,` | `{ 1; 2 }` → `{ 1, 2 }` |
| Blank lines | Runs between statements survive, capped at two; stripped at file start/end and block edges | three blank lines → two |
| Comments | Survive verbatim (text untouched, original long-bracket levels); own-line comments keep their own line at the local indent; same-line comments stay trailing; a comment inside an expression moves to the end of that statement's line | `x = 1 -- note` stays |
| Statement separators | Redundant `;` dropped; a statement beginning with `(` is printed with a leading `;` only when a statement precedes it in its block (Lua 5.1 admits `;` solely *after* a statement — `chunk ::= {stat [';']}` — so a block-start `;` would not load under PUC Lua); a range splice never doubles a `;` the untouched prefix already carries | `a = 1;` → `a = 1`; `local f = g` then `;(f or g)()`; `(f or g)()` opening a block stays bare |
| Call sugar | Paren-free call arguments gain parentheses | `require "m"` → `require("m")` |
| Parentheses | Never added or removed around expressions (a `(x)` node is meaningful in Lua: it truncates multiple values) | `(f())` stays `(f())` |
| Operators | One space around binary operators and `=`; none after unary `-`/`#`; `not` keeps its space; `- -x` keeps the inner space so it cannot lex as a comment | `a + b`, `-x`, `not x` |
| Control structures | Headers on one line, one statement per line in bodies; an empty, comment-free body collapses (`if x then end`, `function f() end`) | see CONFORMANCE/format |
| Function literals | A non-empty body always breaks onto its own lines; `function() end` stays inline | `function()\n    f()\nend` |
| Numbers | Preserved verbatim (no re-spelling of hex, exponents, or precision) | `0x1F`, `3.5e-1` stay |
| Line endings | Follow the input: CRLF when the source contains any CRLF, LF otherwise; exactly one trailing newline (token-free files format to themselves) | — |

## Consequences

- Deterministic and idempotent by construction (no map iteration order, no
  environment reads); `fmt(fmt(x)) == fmt(x)` is a tested property across
  `CONFORMANCE/format/` and the `testdata/` corpus.
- The structural-equality guard means a printer bug degrades to "file left
  unchanged" plus a raised `guard_tripped` flag, never to changed runtime
  behaviour of a mission script — and never to a process abort mid-walk.
  The CLI folds a trip into a failing exit code in both modes while the
  walk continues: the file is non-canonical through no fault of the user,
  and a green gate over a known formatter bug would hide it.
- `dcs-studio-cli fmt` writes in place through a same-directory temp file
  renamed over the original, so a crash or full disk mid-write can never
  truncate a mission script; the file is reported only after a successful
  write.
- Respecting the author's single-/multi-line table choice keeps hand-shaped
  mission data tables stable instead of collapsing them at 99 columns.
- `dcs-studio-cli fmt` exits 0 even when files are skipped for parse errors
  (they are reported on stderr; surfacing syntax errors is `check`'s job);
  `fmt --check` exits 1 when a file would change — and both modes exit
  nonzero on a guard trip or a failed write.
- The editor's format-on-demand (issue #18) reuses the same crate, so IDE
  and CI can never disagree about canonical shape.
