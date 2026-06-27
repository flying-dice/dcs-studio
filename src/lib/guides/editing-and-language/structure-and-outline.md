# Structure & outline

The Structure panel shows an outline of the file you're editing — its functions and variables — built by the language engine. It's the fastest way to see a file's shape and jump straight to a declaration.

## Opening the panel

Open the **Structure** panel from the left rail. It always reflects the **active** editor file and updates as you switch tabs and edit.

## Reading the outline

- Each entry is a declaration from the active file. **Functions** show a function icon; **variables** (locals and globals) show a variable icon.
- Declarations nest: symbols declared inside another symbol appear as indented children.
- The outline refreshes as you type, on the same short debounce as diagnostics, so it keeps up with your edits.

## Navigating symbols

- Click an entry to jump to it: the editor caret lands on the symbol's **name** and scrolls into view. You can also focus a row and press **Enter** or **Space**.
- As you move the caret in the editor, the Structure panel highlights the **innermost** symbol whose body contains the caret, so the outline always shows where you are. (The highlight follows the caret after a brief pause.)

## Empty states

The panel tells three situations apart:

- **No file open** — there is no active editor file.
- **No symbols** — the active file is a type the engine understands, but it declares nothing (for example, an empty Lua file).
- **No structure for this file type** — no language engine claims this file, so there is no outline to show.

The outline never lies about which file it describes: when you switch files, the previous file's rows are cleared before the new outline arrives, and a slow or failed response for a file you've already navigated away from is discarded.

## Languages

The outline is available wherever a language engine is: **Lua** (always) and **Rust** (when rust-analyzer is available for the project). See **Language intelligence** for what each language supports.

## Tips

- Structure is for moving around a **single file** by its declarations; to find every **use** of a symbol across files, use **Find Usages** (see **Refactoring**), and to mark arbitrary lines to revisit, use **Bookmarks**.
