# In-sim Lua Debugger

The Debug panel is a real Lua debugger for code running inside DCS. Set breakpoints in your scripts, start a debug session, and when execution hits a breakpoint the sim pauses so you can inspect the call stack, read variables, watch expressions, and evaluate Lua in the paused frame — then step or resume. It is shaped after a familiar IDE Debug tool window.

## Requirements

The debugger drives the in-sim debugger over the bridge, so DCS must be running with the bridge connected — see the **Injecting the bridge** and **Managed Launch (DCS)** guides.

## Opening the Debug panel

In the tool rail along the bottom-left edge, click the **Debug** icon. When no session is active you will see *"No debug session"* with the hint *"Set a breakpoint in the gutter, then click Debug."* A status-bar chip also appears while a session is live — click it to jump back to the panel.

## Setting breakpoints

Click in the editor gutter next to a line to add or remove a breakpoint. Breakpoints are tracked across the whole workspace. Switch the panel to its **Breakpoints** view with the filled-circle button in the toolbar to manage them all in one place:

- Click a `file:line` entry to reveal it in the editor.
- Click the condition area to add a **conditional** breakpoint — the line pauses only when the expression is truthy, e.g. `i == 3`. Press `Enter` to commit, `Esc` to cancel. Clearing the text removes the condition.
- Click the **✕** to remove a breakpoint.

## Starting and controlling a session

Start a session the same way you run a file: **Run → Debug** (`⇧F9`), the **Debug** button in the top toolbar, or right-click a Lua file and choose **Debug '<file>'**. The status line reads *"Running…"* until a breakpoint is hit, then *"Paused at <file>:<line>"*.

The toolbar controls (with shortcuts) are:

- **Resume** (`F9`) — continue until the next breakpoint.
- **Pause** — break into a run that is in flight.
- **Stop** — end the session. This clears breakpoints and unwinds the chunk, so even a runaway or infinite-loop run terminates.
- **Step Over** (`F8`), **Step Into** (`F7`), **Step Out** (`Shift+F8`) — single-step while paused.

Resume and the step actions are enabled only while paused; Pause only while running.

## Inspecting a pause

When paused, the panel shows three areas:

- **Frames** — the call stack. Click a frame to select it and open its source line in the editor. The top frame is marked with a green dot.
- **Variables** — the selected frame's scopes as a lazy tree. Click a node to expand it; children load on demand. The search box filters by variable name or value, auto-expanding matching branches. Before a pause it reads *"Variables appear when paused at a breakpoint."*
- **Console** (right) — evaluate Lua in the selected paused frame. Type an expression and press `Enter`; `Up`/`Down` recall history. The input is enabled only while paused (*"paused only"* otherwise).

## Watches

Above the Variables tree, the **Watches** pane holds expressions you want re-evaluated automatically on every pause and frame change. Type an expression and click **+** (or press `Enter`) to add it. A watch that resolves to a table is expandable inline, just like the Variables tree. Remove a watch with the **✕**. Outside a pause, each watch shows *"— paused only"*.

## Tips and gotchas

- **Variable refs are per-pause.** The Variables and Watches trees reset on each stop, so expanded nodes re-fetch fresh values — you are never looking at stale data from an earlier pause.
- **Selecting a frame retargets evaluation.** The Console and Watches evaluate in whichever frame is selected, so click up the stack to inspect a caller's locals.
- **No session needed to poke at the sim?** Use the **Inspect console** to evaluate an expression and explore the result without pausing anything.
