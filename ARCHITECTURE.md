# DCS Studio — Hexagonal Architecture (Ports & Adapters)

This document is the authoritative spec for the extension's architecture. All code
changes must respect the dependency rule below; it is enforced by an automated
boundary test (`test/architecture/boundaries.test.ts`).

## Layers and the dependency rule

```
src/
  core/            The hexagon. NO imports of `vscode`, Node I/O builtins, or src/adapters.
    domain/        Pure functions, types, parsers, policies. No ports needed to test.
    app/           Use-case services. Depend only on core/domain and core/ports.
    ports/         Interfaces (TypeScript types only) describing what core needs from the world.
  adapters/        Implementations of ports + all VS Code UI glue.
    node/          fs, child_process, net, fetch, os — one file per port implementation.
    vscode/        Webview panels, config reads, notifications, auth, debug factory.
    github/        GitHub REST marketplace adapter.
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
  backend implements the same port.
- **Marketplace backend** — `MarketplacePort`; current adapter is GitHub REST discovery.
  A Rust sidecar over JSON-RPC (see `marketplace/mockData.ts` provenance) implements the
  same port. The live Marketplace and My Mods panels receive the port instance from the
  composition root, so swapping backends is literally one line in `extension.ts`:

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
| `filesystem.ts` | `FileSystemPort` | readText/writeText/exists/isDirectory/readDir/remove/mkdirp/copy (node fs) |
| `ledger.ts` | `SubscriptionLedgerStore` | `load(): Promise<Record<string, Subscription>>`, `save(subs)` (JSON file + regenerates uninstall-all.bat) |
| `archive.ts` | `ArchivePort` | `available()`, `extract(archive, outDir)`, `packagePayload(...)` (7-Zip CLI) |
| `downloader.ts` | `DownloadPort` | `download(url, dest, token?, onProgress?)` streaming (fetch) |
| `linker.ts` | `LinkerPort` | `enable(defs) → LinkResult`, `disable(installed)` (junction/hardlink/symlink w/ rollback) |
| `marketplace.ts` | `MarketplacePort` | `discover(topic)`, `loadProduct(repo)` (GitHub REST) |
| `auth.ts` | `AuthPort` | `getToken(createIfNone)`, `onDidChangeSessions(cb)` (vscode github auth) |
| `manifest.ts` | `ManifestPort` | `parseToml`, `emitToml`, `resolveDest(dest, roots)` (media/manifest-core.js) |
| `installRoots.ts` | `InstallRootsPort` | `savedGames()`, `gameInstall()`, `dataDir()` (vscode config + os probes) |
| `git.ts` | `GitPort` | repo init/status/commit/remote ops used by publish (git CLI) |
| `gh.ts` | `GhPort` | auth check, repo create, release create/delete/upload (gh CLI) |
| `notifier.ts` | `NotifierPort` | `error(err, ctx)`, `info(msg)` (vscode toasts + Report Issue) |
| `bridgeTransport.ts` | `BridgeTransportPort` | connect/send/close + handler callbacks (raw-TCP WebSocket) |
| `registry.ts` | `RegistryPort` | Windows registry value queries (reg.exe) |
| `env.ts` | `EnvPort` | homedir/userProfile/programFiles candidates |
| `clock.ts` | `ClockPort` | `now()` (Date.now) — inject wherever time feeds logic |

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
- Skills bundled-vs-installed status (frontmatter parse, version compare, modified
  detection) is a pure domain module `core/domain/skillsStatus.ts`, driven by the
  `skills/manager.ts` adapter — no dedicated app service.
- Byte formatting shared by publish + bridge console lives in `core/domain/format.ts`.
- Bridge protocol + DAP session translation logic extracted into `core/domain/` pure
  functions where feasible; live transports stay adapters.

## Testing & coverage

- Framework: **vitest** + v8 coverage. Tests live in `test/**/*.test.ts` (outside the
  tsc `src` build). `npm test` runs vitest; `npm run coverage` enforces thresholds.
- **Coverage gate: 100% lines / functions / statements / branches on `src/core/**`.**
  Adapters are excluded from the gate (thin, I/O-bound) but may be tested with fakes.
- Coverage-ignore comments are forbidden except for provably unreachable defensive
  lines, each with a justification comment. Prefer restructuring so the line is
  reachable in a test.
- The boundary test walks `src/core` and fails on any forbidden import.

## Conventions

- Constructor injection (plain object of ports) for services; no DI framework.
- Ports return domain types or throw `Error` with user-actionable messages; user-facing
  presentation happens in adapters. `errors.ts` (`showError`, the "Report Issue" toast)
  IS the extension's notifier path today — every panel routes errors through it.
  `NotifierPort` exists as the injectable seam for any future core service that must
  surface messages itself; its `VsCodeNotifier` adapter simply wraps `showError`, and
  stays unwired until a core service takes the port (wiring it now would be pure
  indirection).
- Persisted formats are frozen: `subscriptions.json` shape (`Record<lowercased repo,
  Subscription>`) and `uninstall-all.bat` semantics must not change.
- Webview HTML/CSP/nonce boilerplate is adapter code; keep message handlers thin —
  translate and delegate to a core service.
