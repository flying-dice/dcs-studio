---
column: todo
labels: [bug, extension]
priority: high
review-verdict: pending
updatedAt: 2026-08-05T19:59:04.000Z
---
# Run in DCS sends a buffer, not a project

[Issue #78](https://github.com/flying-dice/dcs-studio/issues/78), on its own —
the two tickets it spawned during triage (#79, #80) are card 43, because they
are about the manifest schema rather than about what Run in DCS does.

## What it actually is

`dcs.debug.runGui`/`runMission` → `startSession` (`src/debug/factory.ts:113-141`)
→ a DAP session whose adapter sends **the file's text** to the live sim over the
bridge (`debug_run`). It deploys nothing — not the manifest's entries, and not
even the right-clicked file.

For a self-contained script that model is exactly right, and fast. For a project
whose entry file loads siblings from `lfs.writedir()` it fails at the first
`dofile`/`require` with no hint that the dependencies were never put on disk.
Reproduced in QA with the `lua-hook` template: hook in `Scripts/Hooks/`, module
in `Scripts/hello_world_lua_hook/utils.lua`, and
`no file '…\Scripts\hello_world_lua_hook\utils.lua'`. The Lua was correct; the
file simply was not there.

The QA session's file was in Saved Games from an **earlier manual copy** — which
is why the failure looked like a deployment bug rather than a missing feature.

## Fix direction — settled by decision 11

[Decision 11](../../decisions/11-two-ways-to-run.md) is **Accepted**, and it
reframed the card rather than picking from its original menu. Running a file and
running a project are two different acts with different guarantees, so they get
two commands rather than one command with a mode:

1. **Right-click Run in DCS is kept exactly as it is.** Sending the buffer is
   the right answer for a self-contained script, and it is fast. No deployment
   is added to this path — it is not a shortcoming to be fixed.
2. **A central "Run project in DCS"** — project-level, not a per-file context
   action — which goes through the whole process a deployed mod goes through:
   build the bundle publish would produce, install it exactly as a marketplace
   mod is installed, then run. Chosen over applying symlink rules from the
   workspace because the point of running a project is to answer "does my mod
   actually work", and only a byte-identical artefact answers that.
3. **`dofile`/`require` detection bridges them.** Statically scan the file; when
   someone right-click-runs a file that uses either, warn that it will not work
   and point at Run project in DCS.

Note what part 3 **replaces**: the original plan was to warn when the manifest's
`[[symlink]]` dests were missing or stale. Detection is the better signal,
because it keys off what the file actually does — so it fires even when the
manifest is wrong, absent, or is itself the thing the user misunderstood, which
is exactly what happened in the report that produced this ticket.

## Nothing blocks this card

Decision 11 is Accepted. It grew the card from docs-and-a-warning into a
feature, so scope it accordingly.

## Checklist

- [x] Decision 11 accepted — two commands, and the project run builds and installs for real
- [ ] Run/Debug titles and the run-lua docs state the send-the-buffer semantics
- [ ] `dofile`/`require` detection warns on the per-file run, with Run project in DCS offered inline
- [ ] Detection **warns, never blocks** — it is a heuristic with both false positives (comments, strings) and false negatives (aliased or computed calls)
- [ ] Central Run project in DCS: pack via the publish packager, install via the real installer, then run
- [ ] Project-run installs are distinguishable in the ledger from marketplace installs
- [ ] Decide what a tagless project run packs as — it must not collide with or masquerade as a real release
- [ ] Build-step projects (Rust template) fail before packaging with the preflight's message, not inside it

## Comments

- **claude** (2026-08-05T19:07:50.000Z): Raised from the v0.17.0 QA batch. Kept separate from card 43 even though #78's triage is what produced #79 and #80: this card is about what Run in DCS does, that one is about what the manifest recognizes, and they touch different code. One detail from the issue worth not losing — the mangled `…utils.lua'utils` line in the require trace was verified present in the RAW dcs.log, so it is DCS's own logger, not our log pipeline. No ticket needed for it.
- **claude** (2026-08-05T19:59:04.000Z): Decision 11 accepted, and the owner reframed it rather than answering the question as posed. I had asked whether to add a "dev-deploy" companion — a lighter install for iteration. The answer was that running a file and running a project are **two different acts**, so they get two commands: the per-file run stays exactly as it is (explicitly liked, not a shortcoming), and a separate project-level run builds and installs for real. Record rewritten and renamed to `11-two-ways-to-run.md`.
- **claude** (2026-08-05T19:59:04.000Z): Two things in that answer are better than what I proposed, and worth naming so they survive. **(1)** `dofile`/`require` detection beats my manifest-staleness warning: it keys off what the file actually does, so it fires even when the manifest is wrong or absent — which is precisely the situation in the report that produced #78. **(2)** Choosing the full build+install over workspace-sourced links **dissolves the hazard my own record warned about** — workspace links would have pointed into the working tree, where a wrong uninstall deletes source. Installing a built bundle means links point at extracted release content like any other mod, so decision 03's ledger semantics apply unchanged. The cost is a slower loop with no live edits; that is deliberate and should not be quietly optimised away later, because that optimisation *is* this decision reversed.
