# DCS Studio — Hexagonal Architecture (Ports & Adapters)

This document is the authoritative spec for the extension's architecture. All code
changes must respect the dependency rule below; it is enforced by an automated
boundary test (`test/integration/architecture/boundaries.test.ts`).

## Layers and the dependency rule

```
src/
  core/            The hexagon. NO imports of `vscode`, Node I/O builtins, or src/adapters.
    domain/        Pure functions, types, parsers, policies. No ports needed to test.
    app/           Use-case services. Depend only on core/domain and core/ports.
    ports/         Interfaces (TypeScript types only) describing what core needs from the world.
  adapters/        Port implementations that belong to no single feature.
    node/          fs, child_process, net, fetch, os — one file per port implementation.
    vscode/        auth, config-backed install roots, the manifest asset path.
    github/        GitHub REST marketplace adapter.
  <feature>/       Panels, commands and feature glue: marketplace/, install/, bridge/,
                   publish/, setup/, skills/, project/, log/, manifest/, mission/,
                   nav/, docs/, debug/, webview/. These are adapters too — they live
                   beside their feature rather than under adapters/ because each is
                   used by exactly one.
  errors.ts        showError + the prefilled "Report Issue" toast: the notifier path.
  extension.ts     Composition root: constructs adapters, injects them into core services,
                   registers commands/panels. The ONLY place adapters and core are wired.
```

Dependency rule (checked automatically):
- `core/**` may import: other `core/**` modules and `node:path` (pure path math) **only**.
  Forbidden in core: `vscode`, `fs`, `child_process`, `net`, `http(s)`, `os`, `crypto`,
  `stream`, anything from `src/adapters`.
- `adapters/**` may import `core/**` (ports + domain types), never the reverse.
- Panels are adapters: message handlers translate webview messages into core service calls.

## Why: swappable backends

Every external system the extension talks to sits behind a port, so a backend can be
added or removed by writing one adapter and changing one line in the composition root.
The two motivating cases:
- **Subscription ledger** — `SubscriptionLedgerStore` port; current adapter persists to
  `<dataDir>/subscriptions.json` (+ derived `uninstall-all.bat`). A future sidecar/DB
  backend implements the same port — **plus** the uninstall-script capability the My
  Mods panel takes separately (`ensureUninstallBat`/`uninstallBatPath`), which is not
  on the port and deliberately so: persisting subscriptions and emitting the
  emergency `uninstall-all.bat` are different jobs, and a backend that is not a file
  on disk may have no script to offer. The panel names that capability structurally
  rather than through a port, because one implementation does not make a seam
  (see the BOUNDARY rule under Conventions).
- **Marketplace backend** — `MarketplacePort`; current adapter is GitHub REST discovery.
  A Rust sidecar over JSON-RPC implements the same port;
  `test/support/mockMarketplace.ts` is the second implementation that keeps the swap
  honest — the shared contract suite runs its invariants against both. It lives under
  `test/` rather than `src/` because nothing in the extension reaches it: as an adapter
  it was compiled into `out/` and shipped inside every `.vsix`. The live Marketplace and
  My Mods panels receive the port instance from the composition root, so swapping
  backends is one line in `extension.ts`:

  ```ts
  const marketplace = new GithubMarketplace(new VsCodeGitHubAuth());
  // ⇅ e.g. demo against the static sample catalog (same MarketplacePort):
  const marketplace = new MockMarketplace();
  ```

## Port catalog (`src/core/ports/`)

Ports are minimal and intent-level (no shell/HTTP details leak into signatures). All
methods async unless trivially sync. Domain data types live in `core/domain/`, not in
port files, when they carry behavior.

| File | Interface | Responsibility (adapter today) |
|---|---|---|
| `filesystem.ts` | `FileSystemPort` | readText/writeText/exists/isDirectory/readDir/remove/mkdirp/copy/move (node fs) |
| `ledger.ts` | `SubscriptionLedgerStore` | `load(): Promise<Record<string, Subscription>>`, `save(subs)` (JSON file + regenerates uninstall-all.bat) |
| `archive.ts` | `ArchivePort` | `available()`, `extract(archive, outDir)`, `packagePayload(...)` (7-Zip CLI) |
| `downloader.ts` | `DownloadPort` | `download(url, dest, token?, onProgress?)` streaming (fetch) |
| `linker.ts` | `LinkerPort` | `enable(defs) → LinkResult`, `disable(installed)` (junction/hardlink/symlink w/ rollback) |
| `marketplace.ts` | `MarketplacePort` | `discover(topic)`, `loadProduct(repo)` (GitHub REST) |
| `auth.ts` | `AuthPort` | `getToken(createIfNone)`, `currentSession()`, `signIn()`, `onDidChangeSessions(cb)` (vscode github auth) |
| `manifest.ts` | `ManifestPort` | `parseToml`, `emitToml`, `resolveDest(dest, roots)` (media/manifest-core.js) |
| `installRoots.ts` | `InstallRootsPort` | `savedGames()`, `gameInstall()`, `dataDir()` (vscode config + os probes) |
| `git.ts` | `GitPort` | repo init/status/commit/remote ops used by publish (git CLI) |
| `gh.ts` | `GhPort` | install/auth check + login, repo create + topic, release view/create/edit/delete, asset upload/list/delete (gh CLI) |
| `bridgeTransport.ts` | `BridgeTransportPort` | connect/send/close + handler callbacks (raw-TCP WebSocket) |
| `registry.ts` | `RegistryPort` | Windows registry value queries (reg.exe) |
| `env.ts` | `EnvPort` | homedir/userProfile (install roots are pure math in `core/domain/dcsDetect.ts`) |
| `clock.ts` | `ClockPort` | `now()` (Date.now) — inject wherever time feeds logic |
| `scheduler.ts` | `SchedulerPort` | `setInterval`/`clearInterval` over an opaque `TimerHandle` (node timers) — inject wherever a poll loop's cadence feeds logic |

Slice work MAY add new port files here when a genuine boundary is missing; never widen
an existing port with adapter-specific details.

## Core services (`src/core/app/`)

- `subscriptionService.ts` — subscribe/enable/disable/install/update/unsubscribe/
  fetchPlan/list/get. Injected: ledger, archive, downloader, linker, manifest,
  installRoots, filesystem, clock. Pure helpers (repo key, payload-volume selection,
  uninstall-script generation) live in `core/domain/subscriptions.ts`.
- `publishService.ts` — share (repo create/tag rules), cutRelease (volume packaging
  policy, idempotent re-release). Injected: git, gh, archive, filesystem, manifest.
  The Publish panel's synchronous readiness checks are gathered by the adapter
  `publish/preflight.ts` and scored by the pure policy `core/domain/publishChecks.ts`.
- `missionSanitizeService.ts` — MissionScripting.lua sanitize/desanitize sequencing
  (read → compute EOL-preserving edit → back up on first change → write). Injected:
  filesystem. Parsing/edit computation is pure in `core/domain/missionSanitize.ts`.
- `detectService.ts` — DCS Saved Games + game-install detection (ordering, dedup,
  validity). Injected: registry, filesystem, env. Rules are pure in
  `core/domain/dcsDetect.ts`.
- Presenters — `marketplacePresenter.ts` (the pilot), `myModsPresenter.ts` (#40),
  `consolePresenter.ts` (board card 08). Each holds a panel's decision logic as a
  `vscode`-free object that returns state, outgoing messages and described effects;
  the panel shell owns the `WebviewPanel` and performs the effects. Presenters are
  covered by the unit layer; the shells they leave behind stay under integration.
- `webviewContract.ts` — the declared webview ↔ host message contract (board
  card 09): typed unions per covered panel plus a runtime table whose
  `toHost`/`toWebview` arrays are derived from the unions by mapped types, so
  table and union cannot drift without a compile error. Covered panels are those
  with presenters (console, marketplace today); the rest are named in
  `UNCOVERED_WEBVIEWS` and a census test holds that list to exactly the
  `previews/` directory. Extending coverage to a panel means extracting its
  presenter first — an inferred contract is worse than none.
- Skills bundled-vs-installed status (frontmatter parse, version compare, modified
  detection) is a pure domain module `core/domain/skillsStatus.ts`, driven by the
  `skills/library.ts` adapter (`SkillsLibrary`) — no dedicated app service.
- Byte formatting shared by publish + bridge console lives in `core/domain/format.ts`.
- Bridge protocol + DAP session translation logic extracted into `core/domain/` pure
  functions where feasible; live transports stay adapters.

## Testing & coverage

Three layers, each runnable on its own command, each gating its own coverage at
**100% per file** over an include set that does not overlap the others'. A gap in
one layer can therefore never be masked by another layer happening to execute the
same line.

| Layer | Command | Tests live in | Gates coverage of |
|---|---|---|---|
| Unit | `npm run test:unit` | `test/unit/**` | `src/core/**`, `media/*-core.js` |
| Integration | `npm run test:integration` | `test/integration/**` | `src/**` minus the hexagon |
| E2E | `npm run test:e2e` | `tests/**` | `media/*.js` in real Chromium |

`npm test` runs all three in sequence; `npm run coverage` does the same with each
gate enforced. CI runs one job per layer, plus `cargo llvm-cov` for the Rust bridge
and a Windows job that re-runs the headless layers on the shipping OS.

**Run the gates serially, and never two `cargo llvm-cov` invocations at once.**
Both matter for the same reason — a gate that reports the wrong answer is worse
than no gate:

- The vitest layers' include sets are disjoint *by design*, so running them into
  one process defeats the point: a line covered by the wrong layer reports green.
  `vitest run --coverage` at the repo root is worse still — the root config is a
  `projects` config and vitest treats `coverage` as a root-only option, so every
  per-project threshold is silently ignored. Use the per-layer commands.
- Two concurrent `cargo llvm-cov` runs share `bridge/target/llvm-cov-target`, and
  the second's rebuild deletes the first's test binaries. The first then dies with
  `could not execute process … (never executed) / No such file or directory` on
  whichever test happens to be late in the run order. Cargo's file lock does not
  cover it, because `llvm-cov` owns that directory. If a second measurement is
  genuinely needed, give it its own `--target-dir`.

- **Unit** is pure logic: no filesystem, no child processes, no `vscode`. Anything
  needing a seam belongs in integration.
- **Integration** means the seams are real code, not that the OS is. `vscode` is a
  shared test double (`test/integration/support/vscode.ts`) and process/socket
  seams are injected, so the layer stays headless — no VS Code, no display, no DCS.
  Adapters were once excluded from the gate as "thin, I/O-bound"; they had grown
  well past that, and the panels they sat beside were 86–99% decision logic. They
  are now gated like everything else.
- **E2E** drives the real `media/*.js` in Chromium against the `previews/` harness,
  with V8 coverage merged and gated by `scripts/e2e-coverage.mjs`.
- Ports with more than one implementation carry a shared contract suite under
  `test/support/`, run against each one. `MarketplacePort` is the worked example:
  `marketplaceContract.ts` runs the same invariants against the GitHub adapter and
  against `MockMarketplace`, so the documented one-line swap is a checked claim.
  `filesystemContract.ts` now meets it too: it runs against `NodeFileSystem` and
  against `MemFileSystem`, the single unit-layer fake that replaced four
  hand-written ones which each guessed separately at whether `writeText` mkdirps
  and whether `remove` throws on a missing path. A core service can no longer
  pass its unit tests against a fake more permissive than the adapter.
- Coverage-ignore comments are forbidden except for provably unreachable defensive
  lines, each with a justification comment. Prefer restructuring so the line is
  reachable in a test.
- The boundary test walks `src/core` and fails on any forbidden import.
- The domain layer resolves paths with explicit Windows semantics
  (`import { win32 as path }`) regardless of host, because DCS is Windows-only and
  bare `node:path` makes those rules change shape with the developer's OS. Code
  that hands a path straight to a real `node:fs` syscall keeps native paths.

## Conventions

- Constructor injection (plain object of ports) for services; no DI framework.
- Ports return domain types or throw `Error` with user-actionable messages; user-facing
  presentation happens in adapters. `errors.ts` (`showError`, the "Report Issue" toast)
  IS the extension's notifier path today — every panel routes errors through it, and it
  is the whole of the story: there is no `NotifierPort` and no notifier adapter. Core
  services surface nothing themselves; they throw, or return a value the adapter renders
  (the marketplace presenter's `MarketplaceEffect` is the pattern — describe the effect,
  let the panel perform it). Introduce a `NotifierPort` when a core service first has to
  surface a message it cannot express as a return value; until then the port would be an
  abstraction with no caller, and core must never import `errors.ts`.
- Persisted formats are frozen: `subscriptions.json` shape (`Record<lowercased repo,
  Subscription>`) and `uninstall-all.bat` semantics must not change.
- Webview HTML/CSP/nonce boilerplate is adapter code; keep message handlers thin —
  translate and delegate to a core service.
