# Projects & templates

DCS Studio works on one project folder at a time. The Project Launcher — the welcome screen shown whenever no project is open — is where you create a new mod from a template, reopen recent work, or open any existing folder as a workspace.

## Opening the Project Launcher

The launcher appears automatically when the app starts and whenever you close the current project (**File → Close Project**). It has three actions on the left and your **Recent Projects** on the right.

> `⌘` is the Command key on macOS and the Control key on Windows and Linux. Every `⌘` shortcut in this guide works with whichever your machine uses.

## Opening an existing folder

1. Click **Open Project** (shortcut `⌘O`). From inside the IDE you can also use **File → Open Project…**.
2. Choose any folder in the native picker.
3. The folder loads as the workspace and its contents appear in the **Project** tool window.

DCS Studio can open *any* folder, not only ones it scaffolded — it simply browses what is there. A folder does not need a `dcs-studio.toml` manifest to be opened, though studio features like install rules and publishing rely on one. Destructive file operations are confined to the open project root, so browsing a folder is always safe.

## Recent projects

The **Recent Projects** column lists up to eight projects, most-recent first:

- Click a row (or right-click → **Open**) to reopen it.
- Each row shows the project name, its full path, and how long ago you opened it.
- A folder that no longer exists on disk is dimmed and tagged **missing**; it cannot be opened until the folder is back.
- Hover a row and click the **✕** to drop it, or right-click for **Open**, **Remove from recents**, and **Copy Path**.

The list is deduplicated by path and saved locally, so it survives restarts.

## Creating a new project

1. Click **New Project** (shortcut `⌘N`) to open the inline form.
2. Pick one of the three template tiles (described below).
3. Type a **Name** — this becomes the new folder's name.
4. The **Location** defaults to the last place you created a project, or `~/DCSStudio` the first time. Click it to choose a different parent folder.
5. The preview line shows the exact path that will be created: `→ <Location>/<Name>`.
6. Click **Create Project** (or press Enter in the Name field). Press `Esc` to cancel.

The template files are written under the new folder, the project opens immediately as your workspace, and it jumps to the top of Recent Projects. Creation fails if a folder of that name already exists at the location — choose another name.

## The three templates

Every template writes a `dcs-studio.toml` manifest (project metadata plus install rules) and an `.mcp.json` that points an AI editor at the IDE's built-in tool server. Install destinations in the manifest use named roots resolved per machine — `{SavedGames}` for your DCS *Saved Games* folder and `{GameInstall}` for the game install.

### Blank Project

The minimum: just `dcs-studio.toml`, with commented-out examples for dependencies, install rules, and a file manifest. Choose this when you want to lay out the structure yourself.

### Lua Script Mod

A ready-to-run scripting mod. It scaffolds:

- `Scripts/<name>/main.lua` — an entry point that logs through `log.info`.
- `dcs-studio.toml` — with an install rule mapping `Scripts/<name>/` into your DCS *Saved Games/Scripts* folder.
- `README.md` — notes on where DCS runs mission scripts and how `MissionScripting.lua` sanitization works.
- `types/dcs_studio.d.lua` — type definitions so the Lua language tools complete `require("dcs_studio")`.

### Rust DLL Mod

A native mod — a Cargo project that builds a Lua-loadable DLL. It scaffolds:

- `Cargo.toml` and `src/lib.rs` — a `cdylib` whose library name is the Lua module name.
- `.cargo/config.toml` and `lua5.1/lua.lib` — so the DLL links against DCS's own Lua.
- `Scripts/Hooks/<name>_hook.lua` — a GameGUI hook that loads the DLL.
- `dcs-studio.toml` — install rules placing the built DLL under *Mods/tech* and the hook under *Scripts/Hooks*.
- `README.md` and `types/dcs_studio.d.lua`.

Folder and identifier names are derived from the project name. For example, a project named "My Script Mod" scaffolds `Scripts/my-script-mod/main.lua`.

## Tips

- Building a Rust DLL Mod needs the Rust toolchain (`cargo`). See **Run configurations** for the Build action and what happens when no toolchain is installed.
- Once a project opens, everything else lives in the main IDE — see **Workspace tour** for the panels, menus, and status bar.
- The **Marketplace** action on the launcher browses community mods rather than creating one.
