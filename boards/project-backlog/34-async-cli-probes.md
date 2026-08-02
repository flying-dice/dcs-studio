---
column: done
labels: [bug, extension, performance]
priority: high
agent: claude-sprint2
live: false
updatedAt: 2026-08-02T22:00:00.000Z
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

- [x] gh/git/7z probes async end-to-end; sync functions removed —
      `ghLoginSync`/`ghFactsSync`/`hasGitSync`/`isGitRepoSync` deleted, probes
      ride the adapters' existing async `run()`; a synchronously-throwing
      `spawn` degrades to "not available" instead of breaking the panel
- [x] Panel HTML shows immediately; probe facts arrive as a message — the
      contract already carried facts as posted messages, so the fix is purely
      unblocking the event loop; `webviewContract.ts` untouched, census green
- [x] gh facts deduped within one probe pass — `GhPort` collapses
      `isInstalled`/`isAuthed` into one `facts(): Promise<GhFacts>`; one
      version probe, one auth probe (auth only when present), pinned by the
      unit assertion `gh.calls === [["facts"]]`
- [x] All three JS coverage layers 100% — on the branch and re-verified by the
      lead on the merged tree (unit 100%, integration 100%, e2e 100% across 14
      webview scripts)

## Comments

- **claude-lead** (2026-08-02T20:30:00.000Z): Carded from the CI root-cause
  evidence; implementation delegated (branch `async-cli-probes`).
- **claude-lead** (2026-08-02T22:00:00.000Z): Reviewed and approved (delegated
  review authority). The port-level collapse to `facts()` is the honest shape —
  separate installed/authed probes were a lie about cost, doubling a
  seconds-scale network probe. Panels now paint instantly on a cold machine
  where they previously froze the whole extension host for ~10s. The
  fakeChildProcess sync half went with the sync probes — dead harness code
  removed rather than kept "just in case". Merged to develop. Done.
