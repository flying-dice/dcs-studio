---
column: review
labels: [bug, webview, docs]
priority: med
agent: claude
live: false
review-verdict: clean
pr: "https://github.com/flying-dice/dcs-studio/pull/86"
peer-reviewed: no
updatedAt: 2026-08-05T22:10:00.000Z
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

- [x] Blurb states always-included manifest, layout mirroring, folder semantics, naming/splitting
- [x] Section label deep-links to the "What Is a Mod Bundle?" docs page
- [x] `bundlePreview` message on the manifest contract, census updated
- [x] Preview derives naming/always-include/split from the packager's own functions, not a copy
- [x] Missing paths flagged per row
- [x] Folder entries summarized (file count + size) rather than fully expanded past a depth
- [x] Total size, with a note when it crosses the volume-split threshold

## Comments

- **claude** (2026-08-05T19:07:50.000Z): Raised from the v0.17.0 QA batch. #71 alone is a one-sentence copy change and could ship in an afternoon; it is grouped here rather than done standalone because shipping the sentence and then the preview means writing the same explanation twice, in two registers. If the card gets split later, do #71's docs link first — it is useful on its own and costs nothing.
- **claude** (2026-08-05T21:00:00.000Z): Shipped both halves, and they were right to keep together — the blurb and the preview say the same four things in two registers, and the blurb is what an empty form has *instead of* a preview. Copy and deep link in `media/manifest.js:156-166`; the preview block and its render in `media/manifest.js:168-241`; styles in `media/manifest.css:279-347`.
- **claude** (2026-08-05T21:00:00.000Z): The "reuse, don't restate" instruction turned out to demand an extraction, not just an import. The always-include and dedupe rules lived *inline* inside `PublishService.cutRelease` and nowhere else, so there was nothing for a preview to reuse — importing would have meant copying. They are now `archiveFiles` in `src/core/domain/bundlePlan.ts:40-50`, and `cutRelease` takes its file list from it (`src/core/app/publishService.ts:196-206`). Naming reuses `payloadBase`, the threshold reuses `shouldSplit`. There is no second implementation to disagree with.
- **claude** (2026-08-05T21:00:00.000Z): Two behaviour changes fell out of sharing that rule, both fixes rather than regressions, and the second matters. **(1)** A path declared as `dcs-studio.toml` no longer reaches 7-Zip twice. **(2)** A **blank** `[[bundle]]` path is no longer packed — `join(root, "")` is the project root, so publishing a form with an unfilled row swept the entire working tree, `.git` included, into a public release. The form appends `{ path: "" }` on every Add bundled path click, so that was the state of every half-filled manifest. It is now mutation entry `bundle-blank-path` in `scripts/mutate.mjs:209-216`.
- **claude** (2026-08-05T21:00:00.000Z): `FileSystemPort` gained `measure` (`src/core/ports/filesystem.ts:16-38`) — kind, file count and recursive bytes in one probe, with absence as a return value rather than a rejection, because the preview asks about paths a build step has not produced and "not there" is the ordinary answer. `directory` is reported rather than inferred: a one-file folder and that file both measure one, and the preview says something different about each. The walk does not follow links — a `Dirent` reports the entry's own type, so a junction pointing back at an ancestor is counted once instead of recursing until the stack gives out (`src/adapters/node/fs.ts:32-64`). That is now an integration test rather than only a comment, and it fails in ~150ms when the walk is "simplified" to `statSync`.
- **claude** (2026-08-05T21:00:00.000Z): The split note says **likely**, and the hedge is load-bearing. The threshold is on the compressed archive; the form only knows uncompressed source. The directions are not symmetric — under the limit here means under it compressed too, so silence is reliable, while over it may still compress under, so a warning is a warning and not a promise (`src/core/app/bundlePreviewService.ts:52-64`). There is an e2e test asserting the word, to stop someone tightening the copy into a claim the data cannot make.
- **claude** (2026-08-05T21:00:00.000Z): The protocol grew a round trip, which this panel had never had — `bundlePreview` → `bundlePreviewResult`, plus `openDocs` for the label link. No request id: the presenter keeps a generation counter and drops the answer to any request a newer one overtook (`src/core/app/manifestPresenter.ts:167-185`), because the panel dispatches with `void handle(m)` and a slow `target/` walk can finish after a later, smaller one. Without it the form could settle showing an answer to a question the user had already changed, with nothing on screen saying so. Mutation entry `bundle-preview-generation`.
- **claude** (2026-08-05T21:00:00.000Z): The reply patches **only** its own block (`patchPreview`, `media/manifest.js:233-241`) rather than re-rendering the form. An answer arriving mid-typing is the normal case — the request that produced it was sent by the user's last keystroke — so a full re-render would rebuild the input they are in and take the caret with it. There is an e2e test that types, waits for the archive name to move, and asserts the input is still focused.
- **claude** (2026-08-05T21:00:00.000Z): Two existing e2e tests broke, correctly: they read `messages[messages.length - 1]` and assumed the last post was the `edit`. `bundlePreview` now rides the same debounce and lands after it. Fixed by reaching for the last **edit** (`tests/manifest.spec.ts:5-17`), which says what the assertion means and will not break again the next time something shares that timer.
- **claude** (2026-08-05T21:00:00.000Z): Gates — lint clean (311 files), both typechecks clean, unit 100% (2106 stmts), integration 100% (2081 stmts), e2e 100% across 14 webview scripts, `npm run mutate` 15 killed / 2 skipped (the two Lua ones need DCS's `lua.dll` on PATH) plus the two new entries killed. Every new e2e assertion was checked against a deliberately broken build first: blanking `patchPreview` kills ten of them.
- **claude** (2026-08-05T22:10:00.000Z): The local review found two blocking issues in my own work, both about the walk being the expensive thing in this panel by orders of magnitude, and both now fixed. **(1)** The walk was synchronous. Measured against this repo's own `node_modules` — 14k files, not a large tree — that is ~430ms of **blocked extension host** per measurement, against ~740ms of wall-clock that yields; the form asks on every pause in typing, so it froze the editor while someone edited a description. `measure` is now the one async method in `src/adapters/node/fs.ts:32-77`, and the comment says why it is the exception. **(2)** It asked far more often than it needed to — three fields decide the answer and the form has a dozen, so typing a description re-walked `target/`. Requests are now keyed on themselves and skipped when unchanged (`media/manifest.js:180-205`).
- **claude** (2026-08-05T22:10:00.000Z): That second fix introduced a staleness trap worth naming, because it is the kind that looks like a feature working. The guard is about the **manifest** not having changed, and the disk changes without it: run the build that produces the missing DLL and every field is exactly as it was, so nothing re-asks and the row goes on saying "build the project first" after you have. Rather than re-walk on the chance that happened, the preview grew a **Re-check** button (`media/manifest.js:207-219`), delegated from the container because `patchPreview` replaces its contents without going through `bind()`. A failed measurement is not cached either — the tree it could not walk was being written at that moment.
- **claude** (2026-08-05T22:10:00.000Z): Noted and deliberately **not** fixed here: a `[[bundle]] path` of `../../elsewhere` reaches outside the project. Unchanged by this card — publish checks existence and packs it either way — so constraining it in the preview alone would break the preview-equals-packager property the whole card is built on. It belongs with the manifest-schema work on card **43** (#79), where what the manifest recognizes is the subject.
- **claude** (2026-08-05T22:10:00.000Z): One process note for whoever hits it next. Mid-review I used `git checkout <file>` to undo a hand-applied mutation, and it took the *uncommitted* work in that file with it — twice, silently, because the file was tracked and the working copy was the only place the change existed. `scripts/mutate.mjs` warns about exactly this ("never `git checkout` — a restore that reaches for git is a restore that can take the rest of the working tree with it"), and the warning is about the script, not just about the script. Commit before hand-mutating, or copy the file aside.

## Gates

- [x] static — `npm run lint && npm run typecheck:tests` green, 311 files (claude, 2026-08-05T22:10:00Z)
- [x] coverage — unit / integration / e2e run serially, each 100% against its own include set (claude, 2026-08-05T22:10:00Z)
- [x] code-review — `change-review` found two blocking issues (a blocking sync walk, and re-measuring on edits the preview ignores); both fixed in b785c5a, re-review clean (claude, 2026-08-05T22:10:00Z)
- [x] pr-open — raised as [#86](https://github.com/flying-dice/dcs-studio/pull/86), stacked on #85 which carries this card (claude, 2026-08-05T22:10:00Z)
- [x] ci — all six checks green on #86, Windows shipping target included (claude, 2026-08-05T22:10:00Z)
