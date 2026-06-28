# Bookmarks

Bookmarks are lightweight, personal `file:line` marks you attach to meaningful spots in your project — the mission-start hook, a spawn table, a `require` you're chasing. You set them from the editor gutter, browse them in the Bookmarks panel, and click to jump back. They are saved per project and never written into your source.

## Setting and removing bookmarks

- Click the **bookmark gutter** — the clickable column just inside the editor — on any line to toggle a mark there. Click the same line again to remove it.
- Bookmarks work in **every file**, not just Lua, and on any line.
- You can also remove marks from the panel: hover a row and click its **×**, or click **Clear** in the panel header to remove every mark in the project.

## The gutter and the panel

A bookmarked line shows a dot in the editor's bookmark gutter, so marks are visible while you work.

The **Bookmarks panel** in the left rail lists every mark for the current project:

- Marks are grouped by file, showing the file name, its path, and a per-file count.
- Each row shows the line number and a **snippet** of that line's text (trimmed, and capped in length) as its label; a blank line reads "(blank line)".
- The header shows the total mark count and the **Clear** button. With no marks, the panel reads "No bookmarks yet — Click the editor gutter to mark a line."

## Navigating

Click any row in the panel to jump to its mark: the file opens (if it isn't already) and the caret lands at the start of the bookmarked line, scrolled into view. This is the same open-and-jump used by the Problems and Todos panels.

## Edit-tolerant anchoring

A plain line number would drift the instant you insert a line above it. Bookmarks avoid that:

- **While a file is open**, its marks ride your edits. Insert lines above a bookmark and it shifts down with its code; delete lines above it and it rides up. A mark binds to the code that *follows* it, so deleting the marked line itself lands the mark on the next line of code.
- **On save**, the re-mapped line positions and freshly read snippets are written back to storage for that file (only that file's marks are updated; every other file's marks are left alone).
- **A closed file's** marks can't ride edits, so they keep their last-saved line. This is the one documented limit: if you change a file outside the editor, that file's marks may drift until you open and re-save it.

## Persistence

Bookmarks are saved per project and survive reloads. They are keyed by the project's canonical root path — the same identity the editor uses to avoid opening a file twice — so opening a different project shows only that project's marks, and one project's marks never bleed into another. Because they are personal UI state, bookmarks live alongside your other preferences, never in the project's source files.

## Tips

- Use bookmarks for spots you keep returning to, within a session or across sessions; to jump around a single file by its functions and variables instead, see **Structure & outline**.
- To find where a symbol is *used* (rather than marking a spot by hand), see **Find Usages** in **Refactoring**.
