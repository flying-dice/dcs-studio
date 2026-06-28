# DCS Log viewer

The DCS Log viewer tails DCS World's `dcs.log` inside the editor, so you can watch what your script actually did in-sim — `print` output, Lua errors, and the bridge's own logger output — without alt-tabbing to a text file. Lines from your current mod can be highlighted and isolated.

## Opening the viewer

In the tool rail along the bottom-left edge, click the **DCS Log** icon. The panel reads `Logs\dcs.log` from your detected DCS write directory — the same write dir the bridge installs into (see the **Injecting the bridge** guide). On a machine with no DCS, or before the log exists, the panel simply shows an empty view rather than an error.

## Following the log

- **Follow / Pause** — the play/pause button toggles live tailing. While following, the panel refreshes about every 1.5 seconds and auto-scrolls to the newest line.
- **Refresh** — re-read the log immediately.
- **Clear view** — empty the on-screen view (it does not touch the file; new lines reappear as the log grows).
- A small **tail** badge appears when the log is larger than the read cap, meaning you are seeing only the most recent portion.

If there is no output yet you will see *"No DCS log output yet. Launch DCS to see what your script does in-sim."* — start DCS via the **Managed Launch (DCS)** guide to generate activity.

## Filtering

- **Filter** — type any text to show only lines containing it (case-insensitive).
- **Severity colours** — `ERROR` lines are red, `WARNING` lines amber, `INFO` lines normal, and unparsed lines muted, so problems stand out at a glance.

## Highlighting your mod

DCS logs are shared by the whole game, so the viewer can pick out the lines that belong to *your* mod:

- The **mod** tag field is seeded from your open project's folder name, and you can edit it to whatever namespace your script logs under (for example, the tag you pass to the bridge's logger, or the word your mission script tags `env.info` output with).
- A line counts as yours when its log subsystem equals the tag, or — for tags of four or more characters — when the tag appears as a whole word in the line. The four-character floor stops a short name like `DCS` from matching nearly everything.
- Matching lines are highlighted with a coloured outline.
- **only this mod** isolates the view to just those lines, and shows a count of how many matched.

When a filter or the only-this-mod toggle hides everything, the panel reads *"No matching log lines"* (naming the mod tag when relevant).

## Tips and gotchas

- **It is read-only.** The viewer never writes to `dcs.log`; **Clear view** only clears what is on screen.
- **No log dir, no problem.** With no DCS write dir detected the panel stays empty rather than erroring — inject the bridge and launch DCS to populate it.
- **Console vs. log.** The **Lua Console** shows the *return value* of code you ran; the DCS Log shows what the sim itself printed and logged. Use both together when debugging a script.
