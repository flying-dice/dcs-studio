# Refactoring

DCS Studio's language engine powers three code-navigation and refactoring actions: jump to a definition, list every use of a symbol, and rename a symbol across the whole project. These work for Lua through the built-in `lua-analyzer` engine, and for Rust through rust-analyzer when it is available (see **Language intelligence** for what each language supports).

`Mod` means `Ctrl` on Windows/Linux and `Cmd` on macOS.

## Availability

These actions depend on a ready language engine for the file's type. Until the engine is ready, the **Go to Definition** and **Find Usages** entries on the editor's right-click menu are disabled. For Lua the engine is always available; for Rust it requires a `Cargo.toml` in the project and a rust-analyzer binary installed on your system.

## Go to Definition

Jump from a use of a symbol to where it is declared.

- Put the caret on a symbol and press `F12`, or **`Mod`-click** the symbol, or right-click → **Go to Definition**.
- The declaring file opens (if it isn't already active) and the caret lands on the declaration, scrolled into view. The jump works across files.
- For Lua, this also resolves `require("module")` calls: go-to-definition on a require jumps into the module it resolves to, including dependencies vendored under `.lua-cargo/deps`.
- If the symbol resolves to nothing, the action simply does nothing.

## Find Usages

List every place a symbol is used.

- Put the caret on a symbol and press `Shift-F12`, or right-click → **Find Usages**.
- Results open in the **Usages** panel, grouped by file. The header shows how many usages were found and the symbol's name; each row shows a preview of the line plus its `line:column`, and clicking a row navigates to that occurrence.
- The list is scope-aware and includes the declaration itself: a local's usages stay within its scope, while a global's span the whole workspace.
- When nothing is found, the panel shows "No usages found".

## Rename Symbol

Rename a symbol everywhere it appears, in one action.

- Put the caret on the symbol and press `F2`. A small inline widget opens over the caret, pre-filled with the current name and selected so you can type a replacement.
- Press **Enter** to apply, or **Escape** to cancel. Applying rewrites every occurrence — the declaration and all uses, across every affected file — as a single undoable edit.
- A rename is **refused** (the widget stays open with an explanation) when:
  - the new name is not a valid identifier, or is a language keyword; or
  - any file the rename would touch has **unsaved edits**. Save those files first, then rename again — this guard ensures a rename never clobbers or half-merges unsaved work.

Rename is invoked with `F2`; it is not on the right-click menu.

## Not yet available

- **Expand selection** (grow the selection outward by syntactic scope) is **not yet bound**. The usual command relies on a full syntax tree, which the current Lua highlighting does not provide; a future Lua grammar is needed. It is tracked separately.

## Tips

- **Find Usages** is the symbol-aware way to see where something is used across the project; for free-text searching, see **Search** (and note that project-wide text search is still planned).
- **Go to Definition** and **Find Usages** are also reachable from the editor's right-click menu, alongside Cut/Copy/Paste and **Format Document / Selection**.
- If an action seems to do nothing, check the language engine's status in the status bar — see **Language intelligence**.
