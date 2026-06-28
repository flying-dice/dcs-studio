# Run configurations

The run configuration widget in the top toolbar runs and debugs your Lua scripts against a live DCS World session. It works WebStorm-style: you pick a configuration, then use Run, Debug, or Stop.

## Where it lives

The widget sits in the top toolbar, just right of the menu bar (see **Workspace tour**). It has four parts:

1. A **configuration selector** showing the current config (default: **Current File**).
2. **Run** — a green play button.
3. **Debug** — a bug button.
4. **Stop** — a square button.

## Choosing a configuration

- **Current File** is the default. It always targets whatever Lua file is active in the editor; the selector reads `Current File — <filename>`.
- To pin a configuration to a specific file, right-click a `.lua` file in the Project tree and choose **Run '<file>'** or **Debug '<file>'**. The new config is added to the selector and selected.
- Open the selector dropdown to switch configs. Remove a pinned config with the **✕** beside it. The **Current File** config is always present and cannot be removed.

Only Lua scripts can be run. Run and Debug are disabled whenever the target is not a `.lua` file, so Rust, TOML, and JSON files are never runnable.

## Run (⇧F10)

**Run** evaluates the script in a running DCS through the studio bridge. For the **Current File** config it is selection-aware: if you have text selected in the editor, only that selection runs; otherwise the whole file runs. Results and errors appear in the **Console** (the Lua console in the bottom panel).

Because Run evaluates against a live sim, DCS must be running and connected — watch the **DCS** indicator in the status bar (green means a mission is live). If DCS is offline there is nowhere to evaluate.

## Debug (⇧F9)

**Debug** starts the in-sim line-hook debugger on the selected script. A debug session opens: the status bar shows **Debug: running** or **Debug: paused**, and the **Debug** panel (bottom rail) is where you step, resume, and inspect. Debug is disabled while a session is already running.

## Stop

**Stop** ends the live debug session and runs its teardown. It is enabled only while a debug session is active — a plain Run has no long-lived process to stop.

## Building

Run and Debug execute scripts; **Build** compiles native code.

- Start a build from **Run → Build Project** or the **Build** button (hammer icon) in the toolbar. The **Output** panel opens and shows the result.
- For a project with a `Cargo.toml` at its root (such as a **Rust DLL Mod**), Build runs `cargo build` and streams its output to the Output panel line by line.
- For **Lua Script** and **Blank** projects there is nothing to compile, so Build succeeds immediately as a no-op.
- If the Rust toolchain is missing, the build fails with guidance to install Rust via `rustup`, and the IDE stays responsive.

After a successful Rust build, use the **Install** / **Uninstall** toolbar buttons to deploy the built files into DCS via the project's install rules (see **Projects & templates** for how templates define those rules).

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Run | `⇧F10` |
| Debug | `⇧F9` |
| Build Project | `⌘F9` (Run menu) |

Run and Debug work as global keyboard shortcuts — press them from anywhere in the editor. Build Project appears as `⌘F9` on the Run menu; start a build from that menu item or the toolbar **Build** button. (`⌘` is Command on macOS, Control on Windows and Linux; `⇧` is Shift.)

## Tips

- The same Run and Debug actions are also on the **Run** menu.
- Today every configuration targets a running DCS (the `dcs` target). A local-interpreter target is planned but not yet available.
- Keep an eye on the **Types** indicator in the status bar — Run and Debug behave best when your type definitions match the running build (see **Workspace tour**).
