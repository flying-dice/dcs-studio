# Notifications

DCS Studio keeps a running history of the transient events that would otherwise just flash past — a build finishing, the DCS link dropping or recovering, a publish succeeding or failing, the MCP server failing to bind. The **Notifications** panel is that durable record, and an unread badge on the rail's bell tells you when something new has arrived.

## Opening the panel

Open **Notifications** from the right-hand rail's **bell**. The bell carries an **unread badge** counting the notifications you haven't seen yet; opening the panel marks the whole backlog read and clears the badge. While the panel stays open, new arrivals are added quietly without re-raising the badge.

The panel header shows the total count (for example, `3 notifications`, or `1 notification`). Entries are listed newest-first.

## Severity levels

Every notification carries one of four severities, each with its own icon and colour:

- **info** — neutral, for-your-awareness events (a blue info icon).
- **success** — something completed cleanly (a green check).
- **warning** — something worth noticing but not a failure (an amber triangle).
- **error** — something failed and may need action (a red cross).

## Sources

Each row is tagged with the source that emitted it, shown as an upper-case chip:

- **build** — a build finished.
- **dcs-link** — the DCS connection dropped or came back.
- **launch** — a managed DCS launch exited.
- **publish** — a share or release result.
- **mcp** — the IDE's MCP server status.
- **lsp** — a language server exited unexpectedly.
- **marketplace** — a Marketplace mod finished installing (see the **Marketplace** guide).

## What gets recorded

Not every event earns a durable entry — the panel keeps only what is worth reviewing:

- **Builds:** a failure is recorded as an actionable error; a success is a review-only success; a build with nothing to compile records nothing. (See the **Build** guide.)
- **DCS link:** a drop is a **warning** (a test in flight just lost its sim); a reconnect is a review-only success.
- **Launch:** a managed DCS launch exiting is recorded as info.
- **Publish:** a failed share or release is an actionable error; a successful one is a success. (See the **Publish & Share** guide.)
- **MCP server:** only a fail-closed bind error (the port is already in use) is recorded; a healthy server stays silent, because the status bar already shows it. (See the **MCP server** guide.)

## Actionable vs review-only

Some rows navigate when you click them; others are just a record. An **actionable** row (a failed build, a publish error, a crashed language server) takes you to the right place — the Output panel for a build log, the Publish panel for a publish error, the Problems panel for an engine crash. Review-only rows (link connected, DCS exited, a finished install) never send you somewhere useless.

A row that repeats is folded into a single entry with an `×N` counter rather than stacking duplicates, so a restart storm doesn't bury the list.

## Dismissing and clearing

- **Dismiss one:** hover a row and click its **×** (titled "Dismiss") to remove just that entry.
- **Clear all:** click **Clear all** in the header (titled "Clear all notifications") to empty the panel. With nothing left, the panel shows "No notifications".

Read state drives the bell badge, not the rows themselves: the panel does not mark individual rows read or unread, and there is no manual "mark read" control — opening the panel reads the whole backlog at once.

## Toasts

Error-severity notifications also raise a brief **toast** in the bottom-right corner, so a dead analyzer or a failed build is noticed even when the panel is closed. Toasts:

- appear for **errors only** — info, success, and warning record silently in the panel;
- **auto-dismiss after about five seconds** (or click the **×** to dismiss one sooner);
- **click to focus** — clicking a toast opens the Notifications panel, where the entry lives on, and removes the toast;
- show at most three at once, so the corner never fills up.

Dismissing a toast never deletes the underlying notification — the panel remains the durable home for everything.

## Timestamps and history

- Each row shows a relative time — `just now`, then `Ns ago`, `Nm ago`, `Nh ago`, `Nd ago` — and it keeps ticking while the panel is open.
- The history is capped at the most recent 200 entries, so the oldest fall off the tail over a long session. Notifications live in memory and are not persisted across restarts.
