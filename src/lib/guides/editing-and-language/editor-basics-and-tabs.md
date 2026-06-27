# Editor basics & tabs

DCS Studio edits your project files in a CodeMirror-based editor, with one tab per open file along the top of the editor area. Each tab keeps its own buffer — text, undo history, selection, scroll position, and code folds — so nothing you do in one file ever leaks into another.

Throughout these guides, `Mod` means `Ctrl` on Windows/Linux and `Cmd` on macOS.

## Opening files

- In the **Explorer** (the file tree on the left), click a file to open it. Folders expand and collapse on click; files open in the editor.
- Opening a file that is already open simply re-activates its existing tab — DCS Studio never opens the same file twice, and your pending edits and undo history are left intact.
- Opening never blocks: a file's contents are read from disk the first time you activate its tab, so opening a file doesn't freeze the UI.
- To create a new file, use **File → New File** (`Mod-N`). It adds `untitled.lua` (then `untitled-2.lua`, and so on) under the project root and opens it; rename it from the Explorer.

Binary files (images, archives, and the like) open as a placeholder showing the file's path and size rather than their raw bytes — the bytes are never loaded into the editor.

## Working with tabs

Each open file gets a tab in the strip above the editor, showing a file-type icon and the file name.

- Click a tab to make it active. The previously active tab's buffer is parked — its edits, undo history, selection, and scroll position are restored exactly when you return to it.
- Switching tabs never splices one file's text into another, so **Undo can never resurrect a different file's content**.
- When no files are open, the strip reads `no file open`.

## The dirty indicator

A tab is *dirty* when its buffer differs from what is saved on disk.

- A small dot appears on the left of a dirty tab; hover it for the "Unsaved changes" tooltip.
- The dot clears the moment the buffer matches disk again — after a save, or if you undo back to the saved state.

## Saving

- Press `Mod-S`, or use **File → Save**, to write the active tab to disk.
- Only the **active** tab is saved, and only to its own path. A clean buffer, no open file, or a save already in progress is a no-op.
- If **Format on save** is enabled, the buffer is reformatted before it is written — see **Formatting & format-on-save**.

## Closing tabs

- Click the **×** on a tab to close it.
- Closing a tab that has unsaved edits asks you to confirm before the edits are discarded; declining keeps the tab exactly as it was. If no confirmation dialog is available, the answer is treated as "no" — unsaved work is never silently thrown away.
- Closing the active tab activates a neighbouring tab; closing the last tab returns the editor to the `no file open` state.

## When a file changes on disk

If a file changes on disk while you have unsaved edits in its tab, a banner appears across the top of the editor: *"This file changed on disk while you have unsaved edits."* You can either:

- **Reload from disk** — discard your buffer and load the new on-disk contents, or
- **Keep my changes** — dismiss the banner and keep editing.

A file with **no** unsaved edits is reloaded automatically when it changes on disk, so the editor always reflects the latest version.

## Tips

- The right-click menu in the editor offers Cut, Copy, Paste, **Format Document / Selection**, **Go to Definition**, and **Find Usages**; for Lua files it also offers **Run** and **Debug**.
- Handy line edits: `Mod-/` toggles a comment, `Alt-↑/↓` moves the current line (or selection), and `Shift-Alt-↑/↓` duplicates it. Undo and redo are `Mod-Z` and `Mod-Shift-Z`; indent less/more is `Mod-[` and `Mod-]`.
- Press `Mod-Enter` to **Run in DCS** — it sends the current selection, or the whole file if nothing is selected, to a running DCS session; output lands in the Console panel.
- To find text inside the open file, see **Search**; to jump around a file by its functions and variables, see **Structure & outline**; to mark spots to return to, see **Bookmarks**.
