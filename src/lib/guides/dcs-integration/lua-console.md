# Lua Console

The Console is where the results of running Lua in DCS appear. Every run — a whole file, a selection, or a recipe — is evaluated in the running sim and its result (or error) is logged here, newest at the bottom. The panel is output-only: you author Lua in your files and *send* it to DCS from the editor.

## Opening the Console

In the tool rail along the bottom-left edge of the window, click the **Console** icon (it sits with the other bottom-panel tools — Terminal, Problems, Debug, Inspect, DCS Log). The Console also opens on its own whenever you run something, so you do not have to reveal it first.

## Before you can run

Running Lua needs a live connection to the sim. The bridge must be installed and DCS running — see the **Injecting the bridge** and **Managed Launch (DCS)** guides. The status bar's **DCS** indicator shows whether the link is up. With no connection, a run is logged as an error instead of a result.

## Ways to run Lua

All of these evaluate against the live sim and land in the Console:

- **Editor shortcut** — press `Ctrl`/`Cmd`+`Enter` in the editor. It runs the current selection, or the whole file when nothing is selected.
- **Run configuration** — with the **Current File** configuration selected, click **Run** in the top toolbar (or **Run → Run**, `⇧F10`). This runs the active file.
- **Right-click a Lua file** — in the editor or the project tree, choose **Run '<file>'**.
- **Recipes** — in the Recipes panel, a recipe's **Run** button sends its snippet to the Console.

A loaded tab's live buffer is authoritative, so unsaved edits run exactly as written; a file that is not open is read from disk.

## Reading the output

Each run is one block:

- The first line echoes the code you ran (prefixed with `>`).
- Below it, the result is shown. A returned value is rendered as formatted JSON; `nil` is shown when nothing is returned. Successful results are in the normal text colour; errors are shown in red.

The view auto-scrolls to keep the newest run visible.

```
> return 1 + 1
2

> return Export.LoGetSelfData().Name
"FA-18C_hornet"
```

## Clearing the log

Click the trash icon (**Clear output**) in the Console header to empty the log. This only clears the on-screen history; it does not affect DCS.

## Tips and gotchas

- **The file is the source.** Because the Console is output-only, keep your script in a file (or a recipe) and re-run it — there is no inline edit-and-rerun field in this panel.
- **Errors are surfaced, not swallowed.** A Lua error, or a dropped DCS link, appears as a red entry so you can see exactly what failed.
- **Need to inspect a value, not just print it?** Use the **Inspect console** to evaluate an expression and drill into the result as a tree, or the **In-sim Lua Debugger** to pause and step through code.
- **Watching for `print`/`env.info` output from the sim itself?** That goes to the **DCS Log viewer**, not here — the Console shows the return value of what *you* ran.
