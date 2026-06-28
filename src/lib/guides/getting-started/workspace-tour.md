# Workspace tour

Once a project is open, DCS Studio shows its full workspace: a menu bar, a center editor flanked by tool-window panels, vertical rails of panel toggles, and a status bar. This guide names every region so the other guides can point at them.

## The layout at a glance

The workspace is built from floating rounded "islands" separated by thin gaps:

- **Center island** — the editor, with a tab strip across the top.
- **Left panel** — opens beside the editor on the left.
- **Right panel** — opens beside the editor on the right.
- **Bottom panel** — spans the width below the editor.

Each panel is opened from a vertical **rail** of icon buttons. Drag the gap between a panel and the editor to resize it; the width is remembered across restarts.

## The menu bar

The top-left menus each dispatch a real action — no entry is a placeholder.

- **File** — Open Project… (`⌘O`), New File (`⌘N`), Save (`⌘S`), Close Editor, Close Project.
- **Edit** — Undo (`⌘Z`), Redo (`⇧⌘Z`), Cut (`⌘X`), Copy (`⌘C`), Paste (`⌘V`). The Edit items are greyed out unless a text editor is active.
- **View** — quick toggles for **Project**, **Database**, **Recipes**, and **Terminal** (shortcuts to four of the most-used panels).
- **Run** — Run (`⇧F10`), Debug (`⇧F9`), Build Project (`⌘F9`), and Sync Types from DCS. See **Run configurations**.
- **Help** — About DCS Studio.

> `⌘` is Command on macOS, Control on Windows and Linux. `⇧` is Shift.

## The left rail

The left rail has two clusters of buttons:

- **Top** opens the **left panel**:
  - **Project** — the file tree for the open folder, with Refresh and Open Folder buttons in its header.
  - **Bookmarks** — lines you have bookmarked across the project.
- **Bottom** opens the **bottom panel**:
  - **Console**, **Terminal**, **Problems**, **Usages**, **Todos**, **Output**, **Debug**, **Inspect**, and **DCS Log**.

Clicking a button opens its panel; clicking the same button again collapses it. The bottom-panel buttons sit at the foot of the left rail by design, so toggling the bottom panel never shifts the top buttons.

## The right rail

The right rail opens the **right panel**: **Structure**, **Inject**, **Packages**, **Dependencies**, **Publish**, **Mission**, **Database**, **Recipes**, **Notifications**, and **Assistant**. The Notifications button shows an unread badge. *Assistant* is a placeholder — it opens a "coming soon" panel and is not yet functional.

## The top toolbar

To the right of the menu bar sit, in order:

- The **run configuration widget** (config selector plus Run / Debug / Stop) — see **Run configurations**.
- **Build**, **Install**, and **Uninstall** action buttons. (A **Search** button is also present but is not yet wired up.)
- A GitHub sign-in control.
- The **Quick settings** gear.

## Quick settings

Click the gear at the top-right for:

- **Dark mode** — toggle light/dark.
- **Format on save** — reformat the file each time you save.
- **Editor theme** — a submenu of themes grouped into **Dark** and **Light**. Picking a theme also switches the whole app to that theme's brightness.

## Theme switching

You can change theme three ways: the **Editor theme** submenu in Quick settings, the **Dark mode** toggle there, or — before a project is open — the theme dropdown and sun/moon button in the Project Launcher header (see **Projects & templates**). The current theme is always shown at the far right of the status bar with a sun or moon icon.

## The status bar

The bottom strip shows live state, left to right:

- The active file's path (or **Ready**), and a **modified** / **saving…** marker when there are unsaved edits.
- **Language intelligence** dots for **Lua** and **Rust** (green = ready, amber = starting or needs attention, red = crashed).
- **Problem counts** — click to open the Problems panel.
- **DCS** link status — *offline*, *connected · in menu*, or *connected* with the live sim time and latency.
- **Types** sync status — click to sync type definitions from a running DCS.
- **Debug** status, when a session is live — click to open the Debug panel.
- **MCP** server status — click for editor-setup help.
- The current **editor theme**, with a sun or moon icon.

## Tips

- The **View** menu lists only four panels; reach the rest from the rails.
- Drag any panel-to-editor gap to resize; both side widths and the bottom height persist across restarts.
- To leave the workspace without quitting, use **File → Close Project** — you return to the Project Launcher.
