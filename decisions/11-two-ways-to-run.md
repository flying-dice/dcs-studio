---
status: Accepted
date: 2026-08-05
---
# Decision 11 — Two ways to run: the buffer, and the built project

## Context

[Issue #78](https://github.com/flying-dice/dcs-studio/issues/78), board card 42.
Run in DCS (`dcs.debug.runGui`/`runMission` → `startSession`,
`src/debug/factory.ts:113-141`) opens a DAP session whose adapter sends **the
file's text** to the live sim over the bridge. It deploys nothing — not the
manifest's entries, not even the right-clicked file.

For a self-contained script that is exactly right, and fast. For a project whose
entry file loads siblings from `lfs.writedir()` it fails at the first
`dofile`/`require`. The QA report was precisely that shape: a `lua-hook` template
project with its module in `Scripts/hello_world_lua_hook/utils.lua`, failing with
`no file '…\Scripts\hello_world_lua_hook\utils.lua'`. The Lua was correct. The
file was never put there. The QA session's copy was in Saved Games from an
earlier manual step, which is why the failure looked like a deployment bug rather
than a missing feature.

The framing that produced this record asked whether Run in DCS should gain a
"dev-deploy" companion — a lighter-weight install for iteration. **The owner
reframed it, and the reframing is the decision.** Running a file and running a
project are two different acts with different guarantees, and they get two
commands rather than one command with a mode.

## Decision

**Three parts.** Decided by the repository owner.

### 1. Right-click Run in DCS stays exactly as it is

The send-the-buffer model is not a shortcoming to be fixed. It is the right
answer for a self-contained script and it is fast, and the owner explicitly
wants it kept. No deployment is added to this path.

### 2. A central "Run project in DCS" that builds and installs first

A separate, project-level command — not a per-file context action — which
**goes through the whole process a deployed mod goes through**: build the bundle
the publish step would produce, install it exactly as a marketplace mod is
installed, then run.

Chosen deliberately over the cheaper alternative of applying the manifest's
symlink rules directly from the workspace. The point of running a project is to
answer "does my mod actually work", and only a byte-identical artefact answers
it. What runs is what a user receives.

### 3. Detection bridges the two

Statically scan the file for `dofile` and `require`. When someone invokes the
per-file Run in DCS on a file that uses them, **warn that it will not work and
point them at Run project in DCS.**

This replaces the weaker signal originally proposed for this card — checking
whether the manifest's `[[symlink]]` dests are missing or stale. Detection keys
off what the file actually does, so it fires correctly even when the manifest is
wrong, absent, or the very thing the user has misunderstood. That was the case in
the report that produced this ticket.

## Consequences

- **Every project run redeploys.** The edit → run loop is slower than a
  link-based dev install would have been, and edits are never live. That is the
  accepted price of fidelity, and it should not be quietly optimised away later
  by someone who finds the loop slow — that optimisation is this decision
  reversed.
- **The hazard this record originally warned about is gone.** A workspace-sourced
  dev install would have created links pointing *into* the working tree, where
  an uninstall that guessed wrong deletes source files. Installing a built
  bundle means links point at extracted release content, exactly like any other
  mod, so [decision 03](03-install-mods-as-links-not-copies.md)'s ledger
  semantics apply unchanged.
- **The publish and install paths get exercised constantly.** Every project run
  is a rehearsal of packaging and installing, so a break in either surfaces
  during development rather than at publish time. This is a real benefit and an
  argument for the choice beyond fidelity alone.
- A project-run install must still be **distinguishable in the ledger** from a
  mod the user installed from the marketplace, or uninstall and repair will
  treat a developer's own project as someone else's mod.
- A built bundle needs a name and a version. A project run has no tag, so what
  it packs as is an open implementation question — it must not collide with, or
  masquerade as, a real release of the same mod.
- Projects that require a build step (the Rust template) must be built before a
  project run can succeed. The publish preflight's "build your project so the
  `[[bundle]]` paths exist" check now has a second place to fire, and should
  fire *before* packaging rather than failing inside it.
- **Detection warns, never blocks.** `dofile(` and `require(` appear in comments
  and strings — false positives — and can be aliased or computed — false
  negatives. A warning with the Run project in DCS action inline is honest about
  both. Blocking on a heuristic would make the fast path unusable for the
  self-contained scripts it exists to serve.
