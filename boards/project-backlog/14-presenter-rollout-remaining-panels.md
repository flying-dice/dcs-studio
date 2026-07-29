---
column: backlog
labels: [extension, webview, tests]
priority: med
updatedAt: 2026-07-29T07:05:00.000Z
---
# Roll presenters out to the remaining panels, extending the message contract as they land

The explicit follow-on left by cards 08 and 09. Three panels now have
presenters — marketplace (the pilot), My Mods (#40), and the console (card 08)
— and the declared message contract in `src/core/app/webviewContract.ts` covers
exactly those with typed unions on both sides (console + marketplace today; My
Mods predates the contract and is the cheapest next entry).

Nine webviews remain named in `UNCOVERED_WEBVIEWS`
(`src/core/app/webviewContract.ts:259`): docs, log, manifest, mymods, nav,
newproject, publish, setup, skills. The census test
(`test/integration/webview/webviewContract.test.ts`) holds that list to exactly
the `previews/` directory, so every extension shrinks a checked list rather
than an unwritten one.

Order of attack, by decision-logic density rather than alphabetically: the
audit's G5 table (`docs/04-quality/01-testing-audit.md:140-160`) ranks the
panels; `log` and `publish` carried the most logic of what remains. `nav` is a
`WebviewView`, not a panel — it may need its own shape, per card 07's finding
that `navView` hand-rolls teardown for structural reasons.

Per card 09's rule: **a union for a panel whose host half is welded to
`vscode` would leave that half unexecutable — presenter first, contract
second.** One panel per change, each verified the way card 08 was.

## Checklist

- [ ] Add My Mods to the contract (presenter already exists)
- [ ] `log` — presenter + contract entry
- [ ] `publish` — presenter + contract entry
- [ ] `setup`, `newproject`, `manifest`, `docs`, `skills` — same, one at a time
- [ ] Decide what, if anything, `nav` needs
- [ ] Empty `UNCOVERED_WEBVIEWS`, making the census assertion total
