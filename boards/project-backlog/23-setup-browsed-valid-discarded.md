---
column: review
labels: [bug, webview]
priority: low
agent: opus-defects
live: false
updatedAt: 2026-07-31T10:30:00.000Z
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

- [x] Make `media/setup.js` consume `browsed.valid` for the validity pill on hand-browsed paths
- [x] Reconcile the role-less `browse` default (pick one side, pin it in the contract types) — and restore a named test for the echo-which behaviour; the old panel suite's negative case was not carried into the presenter suite (audit note, 2026-07-30)
- [x] e2e: browse to an invalid path shows the warning pill

## Comments

- **opus-defects** (2026-07-31T10:05:00.000Z): Claimed. The pill now consumes the verdict: `media/setup.js:16-19` keeps a per-role record of the last browsed path and its `valid`, `media/setup.js:52-69` looks it up when the path is not a detected candidate, and `media/setup.js:24-34` names what the boolean means per role in the same words the candidates use (`has Config` / `has bin\DCS.exe`). The verdict is keyed by PATH, not by field, so typing over a browsed path drops the claim again rather than carrying it to a path nothing probed.
- **opus-defects** (2026-07-31T10:10:00.000Z): Reconciled the role-less browse on the HOST side, which is a deliberate deviation from the checklist's "echo-which-as-it-arrived": that echo *was* the disagreement. `src/core/app/setupPresenter.ts:153-170` now resolves `which` once (still `DEFAULT_ROLE` = userdata) and uses the resolved role for the dialog, the probe AND the echo, so `browsed.which` is pinned REQUIRED in the contract (`src/core/app/webviewContract.ts:418-431`) while `browse.which` stays optional — the union declares what may arrive, and a stale document may still name no role. With the answer always naming a real field, `media/setup.js:186-196` drops its own opposite fallback (it used to read a role-less answer as `install` and drop a browsed userdata folder into the installation box) and ignores a role it does not recognise. Rejected the alternative of pinning `browse.which` required too: it would delete the presenter's runtime normalisation on the strength of a type that cannot police a stale webview document.
- **opus-defects** (2026-07-31T10:20:00.000Z): Tests. Unit (`test/unit/setup/setupPresenter.test.ts:212-247`): "falls back to the userdata role when the message names none" keeps the dialog-label half, and two new named cases carry the echo — "echoes the role it resolved, not the absent one it was sent" and "probes the resolved role's witness path, not nothing, for a role-less browse". e2e (`tests/setup.spec.ts:69-142`): "browsing to a folder that is not a DCS userdata dir shows the warning pill" (replaces "a hand-picked path outside the detected set gets no validity claim", which pinned exactly the bug), "browsing to a real install folder shows the ok pill for that role", "a path typed by hand, which nothing has probed, still gets no validity claim", and "ignores a browsed answer whose role it does not recognise". `previews/fixtures/setup.js:74-82` now answers an install browse with `valid: false` so the preview shows the warning variant too.
- **opus-defects** (2026-07-31T10:25:00.000Z): Mutation evidence. Stubbing the new lookup out (`if (probed && …)` → `if (false)` at `media/setup.js:62`) fails exactly the three new pill e2e cases (15 passed, 3 failed); re-echoing the unresolved role (`which` → `which: requested` at `src/core/app/setupPresenter.ts:169`) fails both new unit cases. Both mutations reverted from a copy-aside, not a checkout.
- **opus-defects** (2026-07-31T10:30:00.000Z): Ran lint, `tsc -p ./`, `typecheck:tests`, the setup unit suite (27 passed), the setup panel integration suite (9 passed) and `tests/setup.spec.ts` (18 passed) for this card; the full serial gate run — including the 100% coverage gates — is deliberately deferred to one run covering all five cards on this branch, and the `## Gates` evidence lines will be recorded from that run. Moving to review.
