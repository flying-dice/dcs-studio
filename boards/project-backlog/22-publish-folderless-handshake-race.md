---
column: todo
labels: [bug, webview, extension]
priority: low
updatedAt: 2026-07-30T13:20:00.000Z
---
# Publish panel: the folderless boot handshake can lose the load race

Found by card 14's publish-presenter extraction (journalled there), preserved
verbatim rather than fixed mid-refactor.

In a window with no workspace folder, the panel posts `nofolder`
synchronously — potentially before the webview document has loaded — and the
webview's own boot `{type:"refresh"}` is then dropped by the
`if (root === null) return` guard at the top of `media/publish.js`'s router.
If the initial push loses the race, the user sees an empty Publish panel.
Every other covered panel answers its boot handshake unconditionally.

The presenter (`src/core/app/publishPresenter.ts`) is now the single place a
fix goes: answer `refresh` in the no-folder state with the `nofolder` push
(making the handshake unconditional like the other panels), rather than only
pushing it once at construction.

## Checklist

- [ ] Make the no-folder state answer the boot `refresh` instead of relying on the constructor push
- [ ] Unit-drive the race (handshake after a lost initial push) in the presenter suite
- [ ] e2e: folderless preview shows the no-folder pane, not an empty panel
