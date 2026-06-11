# dcs-lua-ls — language-engine specification

Normative spec for the DCS-flavoured Lua language engine. Sections are
numbered §1–§7 and cited from `CONFORMANCE/`, `PATTERNS.md`, and `decisions/`
as `SPEC.md §N`.

## §1 Scope

The engine analyses Lua **source workspaces** for DCS World scripting: it
parses, resolves, infers, and answers LSP-shaped queries. It never executes
Lua. It never touches the filesystem — sources arrive through the session
boundary (`mount` / `set_source` / `remove_source`).

What this spec does not cover: editor UX (markers, panels, keybindings) and
the introspection walker that generates `.d.lua` files — both live on the
IDE side of this repository (`src/`, `crates/app`). The generated *files* MUST conform to §6.

## §2 Source dialect

The engine accepts **Lua 5.1**. DCS embeds LuaJIT, which is source-compatible
with 5.1; JIT-only extensions are not part of the dialect.

- Long brackets carry a level: `[[ ]]`, `[=[ ]=]`, `[==[ ]==]`, … for strings
  and comments (§2.4 of the Lua 5.1 manual governs; level matching MUST be
  exact).
- `goto` and labels are not in the grammar (5.2 feature). `//`, bitwise
  operators, and integer division are not in the grammar (5.3 features).
- Numbers: decimal with optional fraction/exponent, and hexadecimal integers
  (`0x` prefix).
- Escapes in short strings: the 5.1 set (`\a \b \f \n \r \t \v \\ \" \' \ddd`
  and escaped newline). `\z` and `\xXX` are not in the dialect.

## §3 Diagnostics

One diagnostic type for every stage (lex, parse, static, type, lint):

```
Diagnostic { severity, span, code, code_description, message }
```

- `span` is a half-open byte range `[start, end)` into one file's source.
  Line/column are derived at the rendering edge, 1-based, columns in bytes.
- `severity` is `Error | Warning | Info`. `Error` marks input the engine
  cannot fully analyse; `Warning`/`Info` advise and never block analysis.
- `code` is a stable identifier from the registry below. `code_description`
  is a URL to the rule's article, empty when none exists.
- Analysis is total: every stage MUST yield its result plus diagnostics;
  no stage throws on user input.

### §3.1 Code registry

| Range | Stage | Examples |
| --- | --- | --- |
| `LUA-E0xx` | lexical | `LUA-E001` unexpected character · `LUA-E002` unterminated string · `LUA-E003` unterminated long bracket · `LUA-E004` malformed number |
| `LUA-E1xx` | parse | `LUA-E100` unexpected token · `LUA-E101` expected token · `LUA-E102` unterminated block (missing `end`) · `LUA-E103` nesting too deep (recursion cap; totality on a 1 MiB stack) |
| `LUA-Sxxx` | static (resolution) | reserved |
| `LUA-Txxx` | types | `LUA-T001` argument type not assignable to the declared `@param` type |
| `DCS-Wxxx` | DCS-flavoured lints | reserved |

A code, once shipped, MUST NOT be reused for a different rule.

## §4 Annotation dialect

LuaLS/EmmyLua-compatible doc comments (`---` lines) attached to the following
declaration. Tag set: `@class`, `@field`, `@param`, `@return`, `@type`,
`@alias`, `@enum`, `@generic`, `@overload`, `@vararg`, `@meta`. Type
expressions: names, unions (`A|B`), optionals (`T?`), functions
(`fun(a: T): R`), tables (`table<K, V>`), arrays (`T[]`), and literal types.

The annotation parser reads a contiguous `---` run as the block attached to the
following declaration and yields a structured `AnnotationBlock`. Type-carrying
tags (`@param`, `@return`, `@type`, `@class`, `@field`, `@alias`, `@enum`) feed
type checking; the remaining tags are parsed and surfaced (hover) but do not yet
gate diagnostics. Parsing is total: an unknown tag or malformed type expression
degrades to the `any` type and never fails the parse. The dialect targets the
**DCS Lua 5.1/LuaJIT** runtime only — version-conditional semantics of other Lua
runtimes are out of scope. Tag set and LuaLS compatibility are pinned by
decisions/003; goldens live under `CONFORMANCE/annot/`.

## §5 Environment profiles

DCS exposes distinct Lua environments; a workspace file belongs to exactly
one **profile**: `mission`, `gui`, or `export`.

- Profile assignment comes from the host as glob rules (`ProfileRule { glob,
  profile }`); a file matching no rule is `mission`.
- The global graph is partitioned per profile: a global defined only in `gui`
  files MUST NOT resolve from a `mission` file. Cross-profile references are
  the subject of the `DCS-Wxxx` lint range.

## §6 `.d.lua` definition files

A file whose first annotation is `---@meta` is a **definition file**: it
contributes declarations only. The engine MUST NOT report diagnostics inside
it beyond syntax errors, and its declarations are excluded from
find-references results.

Layering, lowest to highest precedence:

1. bundled curated definitions,
2. generated definitions (`types/generated/<profile>/`),
3. hand-written project definitions (`types/`).

A later layer overrides an earlier layer's function signatures and `@type`
declarations per symbol. `@class` fields merge additively; on a per-field
conflict the later layer wins. This ordering is what makes hand-written
refinements over generated stubs durable across regeneration.

## §7 Formatter

The formatter (`crates/dcs-lua-fmt`, decisions/006) prints one canonical
shape for §2-dialect source. It is a printer over the §2/§3 front-end —
never a second parser — and it MUST hold these invariants:

- **Total or untouched.** `format` and `format_range` return either the
  formatted text or `Err` carrying the parse diagnostics. Source with any
  error-severity diagnostic is never partially formatted.
- **Deterministic.** Output is a pure function of `(source, config)` — no
  environment, clock, or iteration-order dependence.
- **Idempotent.** `format(format(s)) == format(s)` byte-for-byte.
- **Semantic-preserving.** Re-parsing the output MUST yield a tree
  structurally identical to the input's, comparing spans-ignored and short
  strings by decoded value, with the multiset of comment texts intact. The
  formatter MUST verify this before returning and yield the input
  unchanged on any mismatch, signalling the trip to the caller
  (`Formatted::guard_tripped`) — never aborting. Statement separators
  (`;`) are dropped, table `;` separators become `,`, paren-free call
  sugar gains parentheses, and trailing commas are normalised — all
  tree-neutral; a statement beginning with `(` is printed with a leading
  `;` when (and only when) a statement precedes it in its block, so
  separator dropping can never merge statements. At a block's start the
  `;` MUST be suppressed: Lua 5.1's grammar (`chunk ::= {stat [';']}`)
  admits `;` only after a statement, and the output MUST stay loadable
  under PUC Lua 5.1.
- **Comment-preserving.** Every comment (line, long-bracket with its exact
  level, `---` doc run) survives with verbatim text. A comment inside an
  expression MAY move to the end of its statement's line. Blank-line runs
  between statements survive capped at two; runs at file start/end and
  block edges are dropped.
- **Range formatting.** `format_range(source, byte_range, config)` widens
  the range to the smallest run of whole statements in the deepest
  statement-reachable block containing it (blocks inside expression-level
  function literals widen to their enclosing statement) and MUST leave
  every byte outside the spliced run identical. The `(`-statement merge
  guard is suppressed when the untouched prefix already ends with a `;`
  separator: the splice MUST NOT produce `;;`, which PUC Lua 5.1 rejects.

Config keys (`dcs-studio.toml` `[format]`, parsed by
`crates/dcs-studio-project`; absent section or field → default):

| Key | Values | Default |
| --- | --- | --- |
| `indent_width` | 1–16 | `4` |
| `indent_style` | `"space"` \| `"tab"` | `"space"` |
| `quote_style` | `"double"` \| `"single"` | `"double"` |
| `max_width` | line-width budget in UTF-8 **bytes**, not display columns (deterministic, cheap proxy; non-ASCII wraps early — conservative); values below 20 clamp to 20 | `100` |
| `trailing_comma` | `"multiline"` \| `"never"` | `"multiline"` |

The house style (spacing, quoting, wrapping, blank-line rules) is pinned in
decisions/006 and exercised by `CONFORMANCE/format/` goldens: `name.lua`
(input) → `name.formatted.lua` (hand-written expected output, default
config). Every golden's expected output MUST itself be a fixed point of the
formatter.
