# Editor keybindings

Editor functions provided by the CodeMirror editor (issue #18). `Mod` is `Ctrl`
on Windows/Linux and `Cmd` on macOS. These are owned by
`src/lib/editor/commands.ts` (the `editorCommands` keymap) and exercised by
`e2e-lang/editor-line-ops.spec.ts`.

## Line / selection ops

| Action               | Keybinding              | Notes                                                       |
| -------------------- | ----------------------- | ---------------------------------------------------------- |
| Toggle line comment  | `Mod-/`                 | Uses the file's comment marker (`--` for Lua, `//` for Rust, `#` for TOML). Comments every line the selection spans. |
| Move line up         | `Alt-ArrowUp`           | Moves the current line or the selected lines.              |
| Move line down       | `Alt-ArrowDown`         |                                                            |
| Duplicate line up    | `Shift-Alt-ArrowUp`     | Copies the current line or selection above.               |
| Duplicate line down  | `Shift-Alt-ArrowDown`   | Copies the current line or selection below.               |

## Formatting

Owned by `src/lib/editor/format.ts`; exercised by `e2e-lang/format.spec.ts`. The
formatter runs in Rust (`crates/dcs-lua-fmt`) behind the `format_source` Tauri
command — the **same engine** the CLI `dcs-studio fmt` / `fmt --check` runs, so
a buffer formatted in the editor is byte-for-byte what CI checks.

| Action            | Keybinding    | Notes                                                                 |
| ----------------- | ------------- | --------------------------------------------------------------------- |
| Format Document   | `Shift-Alt-F` | Reformats the whole buffer when nothing is selected.                  |
| Format Selection  | `Shift-Alt-F` | With a non-empty selection, reformats only the statements it spans.   |

Style comes from the `[format]` table of the project's `dcs-studio.toml` (house
defaults when absent). A buffer that does not parse is left untouched (its
findings show in the Problems panel). **Format on save** (Quick settings, off by
default) reformats the buffer before each write; a syntax error never blocks the
save.

## Navigation / editing from the base setup

These come from CodeMirror's `basicSetup` and are listed here for completeness;
they are not owned by the IDE keymap:

| Action              | Keybinding   |
| ------------------- | ------------ |
| Undo / Redo         | `Mod-z` / `Mod-Shift-z` |
| Indent less / more  | `Mod-[` / `Mod-]` |
| Save                | `Mod-s`      |

## Not yet bound

- **Expand selection.** The conventional command (`selectParentSyntax`) walks a
  Lezer syntax tree, but Lua is currently highlighted by a `StreamLanguage`
  whose tree is token-flat — so it lands on the token under the caret and then
  dead-ends, never growing by scope. A useful expand-selection needs a Lezer Lua
  grammar (or an engine-backed selection), tracked with the grammar/lang work.
