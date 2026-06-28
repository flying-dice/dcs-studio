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

## Code intelligence (issue #18)

Owned by `src/lib/editor/refactor.ts`; backed by the language engine (the
`lua-analyzer` server for `.lua`, rust-analyzer for `.rs`) through the shared
`LanguageProvider` seam. Exercised by `e2e-lang/refactor.spec.ts`.

| Action             | Keybinding              | Notes                                                                 |
| ------------------ | ----------------------- | --------------------------------------------------------------------- |
| Go to Definition   | `F12` or `Mod-Click`    | Jumps to the declaration of the symbol under the caret (cross-file).  |
| Find Usages        | `Shift-F12`             | Lists every occurrence in the **Usages** panel; each row navigates.   |
| Rename Symbol      | `F2`                    | Inline widget; rewrites every occurrence across files. Refused for an invalid name, or when an affected file has unsaved edits (save first). |

These actions, plus **Run in DCS** and Cut/Copy/Paste/Format, are also on the
editor's right-click context menu (issue #17). The language entries are disabled
until the engine is ready.

## Find / Replace (issue #73)

In-file find/replace over the **active document only** (project-wide search is
issue #68). Owned by `src/lib/editor/search.ts` (the `searchExtensions` wiring
over CodeMirror's maintained `@codemirror/search` — no custom engine); exercised
by `e2e-lang/editor-find.spec.ts`. The panel docks at the top and does both find
and replace.

| Action            | Keybinding              | Notes                                                                 |
| ----------------- | ----------------------- | --------------------------------------------------------------------- |
| Find / Replace    | `Mod-f`                 | Opens the find panel over the active buffer, query field focused. Also **Edit → Find / Replace** (disabled when no text editor is open). The editor owns `Mod-f`; the webview's native find is suppressed (global handler in `routes/+page.svelte`). |
| Find next / prev  | `Enter` / `Shift-Enter` | In the panel; wraps at the ends. Outside it: `F3` / `Mod-g` (next), `Shift-F3` / `Shift-Mod-g` (previous). |
| Close find        | `Esc`                   | Closes the panel and returns focus to the document.                   |

Case-sensitive / whole-word / regex toggles live in the panel; an invalid regex
is flagged inline (never a crash). **Replace All** is a single undo step.

## Run in DCS (issue #47)

Owned by `src/lib/components/Editor.svelte` (the `Mod-Enter` keymap) and the
editor + file-tree right-click menus. Sends Lua to the live DCS GUI/hooks
environment via the bridge's `eval`; the result lands in the **Console** panel.

| Action     | Keybinding  | Notes                                                                 |
| ---------- | ----------- | --------------------------------------------------------------------- |
| Run in DCS | `Mod-Enter` | Runs the current selection, else the whole file. Also on the editor right-click menu, the file-tree right-click ("Run in DCS"), and the tab-strip ▶ button (same selection-else-whole gesture for the active file). |

## Application menu (issue #59)

The top File / Edit / Help menus dispatch real actions — no item is a dead
no-op. One carries its own shortcut:

| Action   | Keybinding | Notes                                                                 |
| -------- | ---------- | --------------------------------------------------------------------- |
| New File | `Mod-n`    | Creates `untitled.lua` (then `untitled-2.lua`, …) under the project root and opens it; rename it in the tree. File → New File. |

**Edit menu** — Undo / Redo / Cut / Copy / Paste / Find / Replace act on the
focused editor and are **disabled when no text editor is open** (Find / Replace
is detailed above). Their keys (`Mod-z` / `Mod-Shift-z`
and the platform clipboard keys) come from CodeMirror's `basicSetup`; the menu
routes the same commands through the app store, so the entries are live rather
than decoration. **Help → About** opens the About dialog (app name, real
version, repository / docs links).

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
