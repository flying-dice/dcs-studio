---
status: Accepted
date: 2026-07-13
---
# Decision 01 — GitHub is the whole backend

## Context

DCS Studio distributes community mods. The obvious shape for that is a registry:
a server that holds a catalog, accounts, uploads, and moderation. That shape also
means somebody hosts it, somebody pays for it, and somebody decides what is
allowed on it — for a hobbyist toolchain succeeding two earlier projects
(dcs-dropzone, dcs-fiddle), each of those is a liability rather than a feature.

Reconstructed from the README, which states the position directly rather than
arguing for it: "no account, no central registry, no gatekeeper", and "GitHub
Releases are the source of truth for every mod — there's no server to sign up for
and nothing self-hosted" (`README.md:27`, `README.md:162-163`).

## Decision

There is no DCS Studio server. Discovery is "every public GitHub repo tagged
`dcs-studio`", read through the GitHub REST API
(`src/adapters/github/marketplace.ts`). Distribution is GitHub Releases —
publishing a mod means creating a repo, tagging it, and cutting a release, which
`src/core/app/publishService.ts` drives through the `git` and `gh` CLIs
(`src/adapters/node/git.ts`, `src/adapters/node/gh.ts`).

The extension itself ships the same way: `.github/workflows/release.yml` builds
the `.vsix` and both bridge DLLs on a `v*` tag and attaches them to a GitHub
Release. Marketplace publishing is deliberately manual on top of that.

## Consequences

- No hosting cost, no accounts, no moderation queue, and the marketplace works
  for anyone with a GitHub account and nothing else.
- Publishing requires `git` and the `gh` CLI signed in — real friction for
  "people who have never touched git before", which is why the publish flow is
  three guided steps rather than a form.
- Discovery is bounded by GitHub's search and rate limits, and by whether authors
  remember the `dcs-studio` topic.
- There is no way to unpublish or recall a mod centrally; the author's repo is
  the only lever.
- `MarketplacePort` exists so this is reversible: a different backend is one
  adapter and one line in the composition root. See decision 02.
