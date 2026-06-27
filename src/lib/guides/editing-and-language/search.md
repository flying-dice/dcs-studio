# Search

DCS Studio has built-in **find within the current file** today. **Project-wide search** across every file in your workspace is planned but not yet available. This guide is explicit about which is which, so you know what to expect.

`Mod` means `Ctrl` on Windows/Linux and `Cmd` on macOS.

## Find in the current file

The editor is built on CodeMirror, whose **find panel** is available in any open file.

- Press `Mod-F` to open the find panel for the active editor.
- Type your query; matches are highlighted in the document.
- Press **Enter** to go to the next match and **Shift-Enter** for the previous one.
- The panel also offers **replace** (replace the current match, or all matches) and toggles for **match case**, **regular expression**, and **whole word**.
- Press **Escape** to close the panel.

This find is **scoped to the active file only** — it does not search other open tabs or the rest of the project.

## Project-wide search (planned)

Searching across all files in the workspace — the "find in project" / "find in files" experience — is **not yet implemented** in DCS Studio. It is tracked under issues **#68** and **#73**. Until it ships, there is no free-text search across files.

## Finding things across files today

While full-text project search isn't here yet, the language engine already lets you find code across the project by **symbol**:

- **Find Usages** (`Shift-F12`) lists every use of the symbol under the caret, across every file, in the Usages panel. See **Refactoring**.
- **Go to Definition** (`F12`, or `Mod`-click) jumps to where a symbol is declared, across files. Also in **Refactoring**.

These are symbol-aware rather than free-text — they understand Lua (and Rust, when rust-analyzer is available) declarations and uses, which is often exactly what you want when navigating code.

## Tips

- To browse a single file by its declarations instead of searching, see **Structure & outline**.
- To mark spots you want to return to, see **Bookmarks**.
