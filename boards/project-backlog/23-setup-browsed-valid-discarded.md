---
column: todo
labels: [bug, webview]
priority: low
updatedAt: 2026-07-30T15:10:00.000Z
---
# Setup panel: the host's `browsed.valid` verdict is computed and thrown away

Found by card 14's setup-presenter extraction (journalled there), preserved
verbatim rather than fixed mid-refactor.

When the user browses to a folder, the host does a real filesystem probe of
the role's witness path (`Config`, `bin\DCS.exe`, the 7z file itself) and
ships the verdict as `browsed.valid` — but `media/setup.js:167-172` only
stores the path and re-renders. The validity pill is derived by looking the
path up among the *auto-detected* candidates, which a hand-browsed path is by
definition not in. Net effect: browsing to a wrong folder shows no warning,
while the same wrong folder auto-detected would get a red pill. The old
integration suite asserted `valid` on the wire — true, and the field was
still dead in the UI.

Related smaller disagreement (same journal): a `browsed` with no `which` is
defaulted to userdata by the host but routed to the install box by the
webview's `else`; reachable only from a stale/crafted post.

## Checklist

- [ ] Make `media/setup.js` consume `browsed.valid` for the validity pill on hand-browsed paths
- [ ] Reconcile the role-less `browse` default (pick one side, pin it in the contract types) — and restore a named test for the echo-which-as-it-arrived behaviour; the old panel suite's negative case was not carried into the presenter suite (audit note, 2026-07-30)
- [ ] e2e: browse to an invalid path shows the warning pill
