# Todos

The **Todos** tool window collects the comment-tag markers scattered across your project — `TODO`, `FIXME`, and friends — into one reviewable list, grouped by file. Click any entry to jump straight to the line that wrote it. The scan runs natively over your whole workspace, so it stays responsive even on large projects.

## Opening the panel

The Todos panel is one of DCS Studio's tool windows. Open it from the IDE's tool-window rail; the panel header shows the current item count (for example, `12 items`, or `1 item` when there is exactly one).

When a project first opens, DCS Studio scans the whole workspace automatically, so the list is already populated by the time you look at it. With no project open there is nothing to scan and the panel stays empty.

## Recognized markers

By default the scanner looks for four comment tags, matched **case-sensitively**:

- `TODO` — work still to be done.
- `FIXME` — known-broken code that needs repair.
- `HACK` — a deliberate shortcut worth revisiting.
- `XXX` — a danger or warning marker.

Each tag is colour-coded in the list (TODO blue, FIXME red, HACK amber, XXX purple) so you can scan by category at a glance. Any other tag the scanner emits still appears, shown in a neutral colour.

Because `TODO` is matched, the repository's own `TODO: clean-code - <score> - <CAT>: …` skill markers surface here too.

### How a line is matched

- A tag matches **anywhere in a line**, as long as it is bounded by non-word characters on both sides (the start and end of the line count as boundaries). So `TODO:` matches, but `TODONT` and `mytodo` do not.
- Matching is **case-sensitive** — a lower-case `todo` is not picked up.
- **At most one entry per line:** if a line holds more than one tag, the earliest one wins.

## Reading the list

Entries are grouped by file. Each group header shows the file's name, its full path, and how many tags it contains. Within a group, every row shows:

- the **tag** as a coloured chip,
- the **text** that follows the tag on that line (the note itself), and
- the **line:column** position (for example `42:7`).

## Jumping to a tag

Click any entry to open its file in the editor with the caret placed exactly on the tag's line and column — the same open-and-jump behaviour as the Problems panel. If the file was not already open, it opens in a new tab first. Columns are counted precisely (in UTF-16 code units), so the caret lands on the tag itself, not a few characters off.

## Refreshing and rescanning

- **Automatic, on open:** opening a project triggers a full workspace scan, sorted by path and then line number.
- **Automatic, on save:** saving a file re-scans just that file and splices its fresh results into the list. Every other file's entries are left untouched, so saving never disturbs the rest of the list.
- **Manual:** click **Refresh** at the top-right of the panel (titled "Rescan workspace") to re-scan the whole workspace. While a scan is running the refresh icon spins and the list shows `Scanning…`; when no tags are found it shows `No TODO comments found`.

## Tips and troubleshooting

- The scan is **gitignore-aware**: files your `.gitignore` excludes are not scanned, so build output and vendored code won't flood the list.
- Files larger than **1 MiB** and **non-UTF-8 (binary)** files are skipped.
- A tag you expected is missing? Check its case (it must be upper-case), and that the file isn't gitignored, over the size cap, or sharing a line with an earlier tag.
- A failed scan never breaks the panel — it simply shows nothing rather than an error.
- Looking for runnable code snippets rather than to-do notes? See the **Recipes** guide.
