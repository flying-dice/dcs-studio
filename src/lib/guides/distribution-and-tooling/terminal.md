# Terminal

The integrated terminal gives you tabbed shell sessions inside DCS Studio, without leaving the IDE. Each tab is a real pseudo-terminal, so interactive programs and full-screen text UIs render correctly, and sessions keep running even when you hide the panel.

## Opening the terminal

Open it from the menu bar with **View → Terminal**, or toggle the **Terminal** panel from the tool rail on the left. The terminal lives in the bottom panel, in the slot labelled **Terminal**.

The integrated terminal is a desktop-app feature. If you are viewing DCS Studio in a plain browser, the panel shows *"The integrated terminal requires the desktop app."* instead of a session.

## Sessions and tabs

- Each session is its own tab in the strip across the top of the panel, marked with a terminal icon and the profile's label.
- Click a tab to bring that session to the front. Only the active session is shown; the others keep running hidden.
- Hover a tab and click the **×** (*Close session*) to end it. Closing a tab kills its process, closes the pseudo-terminal, and removes the tab.
- Click **+** (*New terminal session*) to open the launch-profile picker and start another session. There is no fixed limit, and concurrent sessions are fully isolated — typing into one tab never leaks into another.
- When there are no sessions, the panel reads *"No sessions. Click + to launch a shell or an agentic harness."*

## Launch profiles

The **+** picker lists the available launch profiles in order: the detected default shell first, then the built-in agentic harnesses, then any profiles you have defined in settings.

- **Shell** — the detected default shell. On Windows the IDE prefers PowerShell 7 (`pwsh`), falling back to Windows PowerShell and then `cmd`; on other platforms it uses your login shell.
- **Agentic harnesses** — built-in profiles for **Claude Code** and **OpenCode**. These are marked as *harness* profiles, which changes how they launch (see below).
- **User-defined profiles** — any other CLI tool can be added as a profile, and you can also just type a command into a shell tab. Each profile carries its own command, arguments, and environment variables.

Every session starts in the open project's root directory, so shells and harnesses both begin where you are working.

### Harness profiles and the MCP server

When you launch a harness profile such as Claude Code or OpenCode, the IDE first exposes its hosted MCP server's loopback discovery path to the agent's environment, so the harness can reach the IDE's tools without manual wiring. See the **MCP server** guide for what that server provides and how to point other editors at it.

Note that the terminal itself is *not* exposed over MCP — an agent launched here owns its own shell, and the IDE's MCP surface stays the structured tools.

## Rendering and session survival

- Output is rendered with xterm, themed to match your current editor theme; changing the editor theme re-colours every live terminal.
- A session opens at 24 rows by 80 columns and then fits itself to the panel, re-fitting whenever you resize the panel or change the font.
- **Sessions survive panel collapse.** Hiding the bottom panel only unmounts the *view* — the process and its pseudo-terminal keep running. The IDE retains a rolling buffer of the most recent output (up to roughly 200 KB); when you reopen the panel it first replays that buffered tail and then resumes live, spliced so the boundary neither drops nor repeats output.
- Reloading the webview rebuilds the tab strip from the still-running sessions. Only closing the IDE window actually ends them.
- If a session's program exits on its own (for example you type `exit`), the tab is marked closed and cleaned up. If a profile's command cannot be started, the tab shows *Could not start "…"* with the reason — most often the command is not on your `PATH`.

## Find in the buffer

Press **Ctrl/Cmd+F** with a terminal focused to open the find overlay. Type to search the scrollback, then press **Enter** for the next match, **Shift+Enter** for the previous, and **Esc** to close.

## Tips

- Because every session starts in the project root, you can run project scripts and build commands immediately — no `cd` needed.
- A "could not start" error usually means the command is not installed or not on your `PATH`; install it, or add a user-defined profile that points at its full path.
