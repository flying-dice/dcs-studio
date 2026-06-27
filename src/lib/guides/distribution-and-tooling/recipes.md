# Recipes

The **Recipes** panel is a searchable catalog of small, ready-to-run DCS Lua snippets — from reading the current mission time to writing a CSV file or opening a SQLite database. Each recipe can be run against the live simulator, copied to the clipboard, or dropped into a new file. Where these in-app Guides explain *how* things work in prose, Recipes hand you the runnable *code* to go with them.

## Opening the panel

Open the **Recipes** panel from the IDE's tool-window rail. The Database panel also deep-links here: when it has no databases to show, its **Browse SQLite recipes** link opens Recipes focused on the SQLite category.

## Finding a recipe

- **Search:** type in the **Search recipes…** box at the top. Your query is split into words, and a recipe matches only when *every* word appears somewhere in its title, blurb, tags, or category — so `sqlite csv` narrows down to the SQLite-to-CSV export recipe.
- **Categories:** the chips below the search box filter by group. **All** shows everything; the rest are, in display order: **DCS Basics**, **Bridge**, **Serialization**, **File Dump**, **SQLite**, **Logging**, and **Debugging**. The selected chip is highlighted.

If nothing matches, the panel shows "No recipes match your search."

## Reading a card

Each recipe is a card showing its title, a one-line blurb, its category, and the full Lua snippet in a code block. Some cards carry an **in-mission** badge: those snippets only return live data while a mission is actually running (model time greater than zero) — at the main menu they return nothing useful.

## Running, copying, creating

Every card has three actions:

- **Run** — executes the snippet in the **Lua Console** against the live sim and reveals the console so you can read the result (or the Lua error). Every recipe ends in `return …`, so its value is exactly what you see. The Run button is disabled while another run is still in flight, so overlapping runs can't stack up.
- **Copy** — places the snippet on your clipboard. The button briefly reads **Copied** to confirm.
- **New file** — creates a new file seeded with the snippet at your workspace root and opens it as a tab. This needs an open project; with no workspace open it does nothing.

### The Lua Console is not the Terminal

**Run** sends code to the Lua Console, which evaluates it inside DCS's GUI/hooks Lua state over the bridge — it is *not* an OS shell. To run shell commands and external tools, see the **Terminal** guide instead; the two are separate surfaces and should not be confused.

## How it works under the hood

- Running a recipe takes the same path as the editor's "Run in DCS": the code is sent to DCS over the bridge, evaluated there, and the return value is serialised back into the console log. A `nil` result shows as `nil`.
- Recipes reach the in-sim helpers through `require("dcs_studio")` (the bridge module) and the DCS hooks API (`DCS.*`, `net.*`, `lfs`, `log`).
- The SQLite recipes create database files under the DCS write directory; you can browse those files afterwards in the Database panel.
- The catalog ships with the app and works offline — searching, copying, and creating files from recipes need no network. Running a recipe does need a live DCS link; without one, the console reports the connection error.

## Recipes and these Guides

These Guides and Recipes are complementary. A guide walks you through a feature in prose; a recipe hands you a snippet you can run immediately. When a guide mentions a task that has a matching snippet — querying the sim, dumping data, working with SQLite — switch to Recipes to run it. See also the **Todos** guide for tracking work markers in your own code.
