---
column: todo
labels: [bug, webview, docs]
priority: med
review-verdict: pending
updatedAt: 2026-08-05T19:07:50.000Z
---
# The `[[bundle]]` section doesn't say what ends up in the 7z

Covers [#71](https://github.com/flying-dice/dcs-studio/issues/71) (bug) and
[#72](https://github.com/flying-dice/dcs-studio/issues/72) (enhancement).
#71 says so itself: "the fuller answer is #72" — the preview answers the
confusing copy by *showing* instead of telling. Two tickets, one question.

## #71 — the copy

The section is headed `[[bundle]]` with one line (`media/manifest.js:147`):

> Each entry is a project-relative `path` (file or folder) packed into the
> release archive when you publish.

Owner's words in QA: "the language around the lua bundle is quite confusing in
terms of whats included and how its included in the 7z etc."

Four things the form never says, which the docs page ("What Is a Mod Bundle?",
`media/docs-content.js` `mod-bundles`) does:

- the **manifest itself** is always added alongside the `[[bundle]]` paths;
- the archive **mirrors the project layout** — entries are stored at their
  project-relative paths, not flattened, which is what `[[symlink]] source`
  later resolves against;
- a **folder entry brings its whole tree**;
- naming and splitting — `dcs-studio-<name>-<tag>.7z`, split into numbered
  volumes when large.

Cheapest fix: one more sentence, plus linking the section label to the docs page
(the panel supports deep links via `dcs.docs.open`).

## #72 — the preview

A read-only tree beside the section showing the archive publish would build from
the **current** entries, resolved against the real workspace:

```
dcs-studio-my-mod-v1.2.0.7z
├─ dcs-studio.toml            (always included)
├─ Scripts/my-mod.lua
├─ Scripts/Hooks/…            (12 files, 34 KB)
└─ target/release/my-mod.dll  ⚠ missing - build first
```

Every bullet #71 lists becomes visible rather than described, and the publish
preflight's "build your project so the paths exist" moves to per-row, before
preflight.

**Reuse the packager's own functions for naming, always-include and the split
threshold** — a preview with its own copy of those rules is a preview that
drifts from what publish actually does, which is worse than no preview.
Sizing and existence probes belong host-side behind a `bundlePreview` message on
the manifest contract; the webview stays DOM-only per the architecture. Debounce
with the form's existing edit debounce, minding card 26's external-change
semantics.

## No decision blocks this one

Deliberately checked, not overlooked: every other card in this batch has a
`decisions/` record gating it, and this one has none. The issues prescribe the
answer — reuse the packager's own naming, always-include and split-threshold
functions, probe host-side behind a `bundlePreview` message, keep the webview
DOM-only. Nothing is left open, so it can start today.

## Checklist

- [ ] Blurb states always-included manifest, layout mirroring, folder semantics, naming/splitting
- [ ] Section label deep-links to the "What Is a Mod Bundle?" docs page
- [ ] `bundlePreview` message on the manifest contract, census updated
- [ ] Preview derives naming/always-include/split from the packager's own functions, not a copy
- [ ] Missing paths flagged per row
- [ ] Folder entries summarized (file count + size) rather than fully expanded past a depth
- [ ] Total size, with a note when it crosses the volume-split threshold

## Comments

- **claude** (2026-08-05T19:07:50.000Z): Raised from the v0.17.0 QA batch. #71 alone is a one-sentence copy change and could ship in an afternoon; it is grouped here rather than done standalone because shipping the sentence and then the preview means writing the same explanation twice, in two registers. If the card gets split later, do #71's docs link first — it is useful on its own and costs nothing.
