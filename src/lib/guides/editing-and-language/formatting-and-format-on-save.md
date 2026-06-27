# Formatting & format-on-save

DCS Studio can reformat your Lua to a consistent style on demand or automatically as you save. Formatting runs through the same engine and the same configuration as the command-line `dcs-studio fmt`, so a file formatted in the editor is byte-for-byte what continuous integration checks.

`Mod` means `Ctrl` on Windows/Linux and `Cmd` on macOS.

## Formatting on demand

- Press `Shift-Alt-F` to format. With **nothing selected**, this reformats the whole document; with a **non-empty selection**, it reformats only the smallest run of complete statements that encloses the selection, leaving every byte outside that run untouched.
- The same actions are on the editor's right-click menu as **Format Document** and **Format Selection** (Format Selection is disabled when there is no selection).

## What gets formatted

- Formatting uses the DCS Lua formatter — the engine behind the CLI `dcs-studio fmt` and `dcs-studio fmt --check`. Because the editor and the CLI share one engine and one configuration, the editor's output and CI's expectations can never disagree.
- Style is taken from the `[format]` table of the nearest `dcs-studio.toml`, found by walking up from the file. If no manifest is found, or the nearest one cannot be read or parsed, house defaults are used so formatting always works.
- A buffer that does **not parse** is left completely untouched — its syntax errors show up in the Problems panel instead (see **Language intelligence**). Formatting never half-rewrites a broken file.

## Format on save

Format on save reformats the active buffer just before each write, so what lands on disk is always tidy.

- Turn it on from the **Quick settings** menu (the gear icon in the top bar) → **Format on save**. It is **off by default**, and your choice is remembered between sessions.
- When it is on, saving a file that parses reformats it with the project's `[format]` config and then writes the formatted text, so disk matches exactly what you see after the reformat.
- The setting applies at every save entry point — the editor, the global `Mod-S`, and **File → Save** all behave identically.

### Saving is never blocked

Format on save is a convenience, never a gate:

- If the buffer has a **syntax error**, the save still happens — the file is written **unchanged**, and its parse findings remain in the Problems panel.
- If formatting fails for any other reason, the save degrades to writing the buffer unformatted rather than aborting.
- An already-formatted buffer is written unchanged, so there's no spurious edit or churn.

## Tips

- Keep `dcs-studio.toml`'s `[format]` table in source control so every contributor — and CI — formats identically.
- If you ever see a notice that the formatter's *semantic guard* tripped, the buffer is deliberately left unchanged because the formatted output would have changed the code's meaning; please report the file.
- Pair format-on-save with the diagnostics in **Language intelligence**: formatting tidies style, while diagnostics catch parse and type problems. Saving is also where open **Bookmarks** are re-anchored to their lines.
