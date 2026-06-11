# dcs-lua-ls — language-engine specification

Normative spec for the DCS-flavoured Lua language engine. Sections are
numbered §1–§6 and cited from `CONFORMANCE/`, `PATTERNS.md`, and `decisions/`
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
| `LUA-Txxx` | types | reserved |
| `DCS-Wxxx` | DCS-flavoured lints | reserved |

A code, once shipped, MUST NOT be reused for a different rule.

## §4 Annotation dialect

LuaLS/EmmyLua-compatible doc comments (`---` lines) attached to the following
declaration. Tag set: `@class`, `@field`, `@param`, `@return`, `@type`,
`@alias`, `@enum`, `@generic`, `@overload`, `@vararg`, `@meta`. Type
expressions: names, unions (`A|B`), optionals (`T?`), functions
(`fun(a: T): R`), tables (`table<K, V>`), arrays (`T[]`), and literal types.

The annotation grammar and its conformance layer (`CONFORMANCE/annot/`) are
deferred until the annotation parser lands (plan Phase 3). The tag set and
LuaLS compatibility are pinned now (decisions/003).

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
