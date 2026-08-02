---
column: doing
labels: [bug, extension, performance]
priority: high
agent: claude-sprint2
live: false
updatedAt: 2026-08-02T20:30:00.000Z
---
# Panel opens block the extension host on synchronous CLI probes

Found by the bc682b0 CI investigation: `dcs.publish.open` and `dcs.setup.open`
probe real CLIs through SYNCHRONOUS spawns — `find7z`, `hasGitSync`,
`ghFactsSync` (`gh auth status` goes to the network) — measured at 9.8 s for a
cold `gh --version` on a fresh Windows image (CI run 30763593695). That time is
spent with the event loop held: the whole extension host freezes. The
activation test now stubs the probes (that fixed CI), but the product defect
remains. Both adapters already have an async `run()` helper and the ports are
already Promise-typed — the sync shortcuts exist only for "synchronous
preflight/panel paths", which need to stop being synchronous.

Also: one publish-open runs `gh --version` twice and `gh auth status` twice
(`isInstalled` + `isAuthed` each call `ghFactsSync`) — share one probe pass.

## Checklist

- [ ] gh/git/7z probes async end-to-end; sync functions removed
- [ ] Panel HTML shows immediately; probe facts arrive as a message
- [ ] gh facts deduped within one probe pass
- [ ] All three JS coverage layers 100%

## Comments

- **claude-lead** (2026-08-02T20:30:00.000Z): Carded from the CI root-cause
  evidence; implementation delegated (branch `async-cli-probes`).
