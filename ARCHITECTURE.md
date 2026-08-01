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
| `debugBridge.ts` | `DebugBridgePort`, `BridgeRouterPort` | what a debug session needs of one bridge (console read, REPL eval, run/state/continue/pause/stop, expand/eval, breakpoints) and of the pair (`forEnv`, status subscription) — `BridgeClient` implements it (#61) |
| `skillsCatalog.ts` | `SkillsCatalogPort` | `onDidChange(listener)`, `updatesAvailable()` — the slice of the skills library the nav badge consumes, deliberately not the whole library (`skills/library.ts`) (#61) |
| `registry.ts` | `RegistryPort` | Windows registry value queries (reg.exe) |
| `env.ts` | `EnvPort` | homedir/userProfile (install roots are pure math in `core/domain/dcsDetect.ts`) |
| `clock.ts` | `ClockPort` | `now()` (Date.now) — inject wherever time feeds logic |
| `scheduler.ts` | `SchedulerPort` | `setInterval`/`clearInterval` over an opaque `TimerHandle` (node timers) — inject wherever a poll loop's cadence feeds logic |

Slice work MAY add new port files here when a genuine boundary is missing; never widen
an existing port with adapter-specific details.

Not every adapter has a port. `src/adapters/node/processLauncher.ts` (`ProcessLauncher`
— detached spawn + tracked handles for mod executable entrypoints, `taskkill /T /F` on
stop) is named concretely by `extension.ts` and by the panel it serves, and appears in no
port file. That is deliberate under the BOUNDARY rule below: the decision it embodies is
already pure (`core/domain/entrypointLaunch.ts` builds the `EntrypointLaunchPlan`; the
adapter only spawns it), so a port would abstract a seam nothing needs to swap. It joins
the catalog the day a second launcher exists.

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
- Presenters — **eleven**, one per webview: `consolePresenter.ts`, `docsPresenter.ts`,
  `logPresenter.ts`, `manifestPresenter.ts`, `marketplacePresenter.ts` (the pilot),
  `myModsPresenter.ts` (#40), `navPresenter.ts`, `newProjectPresenter.ts`,
  `publishPresenter.ts`, `setupPresenter.ts`, `skillsPresenter.ts`. Each holds a
  panel's decision logic as a `vscode`-free object that returns state, outgoing
  messages and described effects; the panel shell owns the `WebviewPanel` and
  performs the effects. Presenters are covered by the unit layer; the shells they
  leave behind stay under integration. The rollout ran card 08 → card 09 → card 14,
  and `navPresenter.ts` came last on purpose — the sidebar is a `WebviewView`, not a
  panel, so it was taken as a decision rather than a repetition.
- `webviewContract.ts` — the declared webview ↔ host message contract (board
  card 09): typed unions per covered webview plus the `WEBVIEW_PROTOCOLS` table,
  whose `toHost`/`toWebview` arrays are derived from the unions by mapped types, so
  table and union cannot drift without a compile error.

  Coverage is now **total**, and that is the invariant card 14 left behind:
  `WEBVIEW_PROTOCOLS` has an entry for all eleven webviews and
  **`UNCOVERED_WEBVIEWS = []`**. The empty array is kept rather than deleted,
  because the census in `test/integration/webview/webviewContract.test.ts` asserts
  that the covered names *plus* that list equal the `previews/` directory exactly.
  Empty makes the assertion a TOTAL partition of `previews/`: a **twelfth** webview
  arriving fails the census until someone puts it on one side of the line or the
  other — declares its protocol, or says out loud in `UNCOVERED_WEBVIEWS` that it is
  not declared. The list is the place that second answer goes.

  A webview joins `WEBVIEW_PROTOCOLS` by growing a presenter first. That ordering is
  not style: a union declared for a panel whose host half is welded to `vscode`
  leaves that half unexecutable, and an inferred contract is worse than none.
- Skills bundled-vs-installed status (frontmatter parse, version compare, modified
  detection) is a pure domain module `core/domain/skillsStatus.ts`, driven by the
  `skills/library.ts` adapter (`SkillsLibrary`) — no dedicated app service.
- Byte formatting shared by publish + bridge console lives in `core/domain/format.ts`.
- Bridge protocol + DAP session translation logic extracted into `core/domain/` pure
  functions where feasible; live transports stay adapters.

## The bridge (Rust)

The `bridge/` cargo workspace builds **two** DLLs from a shared `bridge-core`, one
per Lua state DCS gives us. They are separate DLLs because the states have
different lifetimes, and that difference is the whole design.

| DLL | Port | Loaded by | Lives for |
|---|---|---|---|
| `dcs_studio_gui.dll` | `127.0.0.1:25569` | the GameGUI hook (`bridge/hook/DcsStudio.lua`), `require`d once at startup | the process |
| `dcs_studio_mission.dll` | `127.0.0.1:25570` | `require`d into **each** mission scripting state by `mission_init.lua` | one mission, torn down at its end |

Both serve JSON-RPC over WebSocket (`/ws`) plus `POST /rpc` and `GET /health`. The
hook dispatches the mission bridge's boot at mission start; that path needs a
desanitized `MissionScripting.lua` (`require`/`package` restored), which is what
`missionSanitizeService` exists to arrange.

### Resources belong to the Lua state that asked for them

Statics are per-DLL and deliberately minimal, and **the JSON-RPC server is not one
of them**. `jsonrpc.serve` constructs the server inside the Lua call and returns it
as an mlua **userdata that owns it** — listener, actix `System` thread and request
queue together. Each bridge's boot code parks that userdata in its own state (the
hook in its frame callbacks, `mission_init.lua` in its pump closures), so the server
lives exactly as long as the state that asked for it, and `Drop` stops it. There is
no server static and no queue static, so a dead state cannot be reached through one.

This is the repository owner's Lua-lifecycle directive — see
[decision 08](decisions/08-lua-state-owns-its-resources.md). It was born from the
card-18 crash: a server that spanned mission unloads killed DCS roughly ten seconds
after quitting, 6 reproductions out of 6.

Every wait on the shutdown path is bounded, because the caller is the sim thread:
2s + 2s (acknowledge + `System` exit) on the explicit path, 250ms + 250ms when
`Drop` is reached from `__gc` inside DCS's own `lua_close`.

**Teardown ordering is load-bearing** and was verified live. On `S_EVENT_MISSION_END`:

1. release the registered handlers first — each is a live mlua reference into the
   state DCS is about to close;
2. *then* answer the requests stranded in the queue with `-32001`, which reads the
   still-running server's queue and so must precede the stop (40-odd real callers
   per unload in the live runs);
3. *then* stop the listener and wait, bounded, for the actix `System` thread.

### The pump clock, and what "OK" means

The queue is drained once per simulation frame. The pump stamps a liveness clock,
and a request arriving while that clock is stale fast-fails `-32002` "sim not
pumping" rather than burning the 30s request deadline (card 17). Default 2000ms,
overridable per server with `pump_stale_ms`, `0` disables.

`-32002` carries a second meaning as well, told apart by the message rather than
the code: `"queue full"`. The queue is capped at 256 undrained entries
(`QUEUE_CAP`), because everything that fills it runs on the actix worker and
everything that drains it runs on the sim thread — a sim that stops pumping left
a producer running against a stopped consumer with the address space as the only
bound. A *request* arriving at a full queue is refused with the code rather than
dropped, because a caller is waiting and a silent drop is indistinguishable from
a hang. A *notification* has nobody to tell, so it is what gives way: the oldest
queued notification is dropped to make room, and if every entry is an undroppable
request then the arriving notification is dropped instead. `pump_stale_ms = 0`
disables the staleness half only; the cap always applies.

`GET /health` exposes `pump_idle_ms` and `pump_stalled` for exactly this reason:
**status OK is about the listener, not the sim** — a client deciding whether the
sim will answer reads `pump_stalled`, not `status`. It also reports `queue_depth`
against `queue_capacity`, which is the third independent signal after the listener
and the pump: a bridge can be listening *and* pumping and still be falling behind,
and a depth climbing across successive probes is the only way to see that from
outside before the refusals begin.

Both transports also declare a `MAX_PAYLOAD_BYTES` cap of **32 MB**, stated rather
than inherited — actix-web's `Json` extractor defaults to 2 MB and actix-ws to a
64 KB frame, so the limit would otherwise move with a dependency bump. Over-limit
is a clean refusal on both: `413` on `POST /rpc`, decided from `Content-Length`
before the body is read, and a protocol close on the WebSocket. Anything that would
genuinely be tens of megabytes (`db_export`, `repl_export`) writes a file and
returns its path instead of riding the socket.

### Two guards worth knowing

- **The RT guard** (`lua/rt.lua`) serves user chunks a *guarded* view of `DCS`:
  `DCS.getMissionLoaded()` with a mission loaded takes the process down on the spot
  inside ED's own `copyindex` recursion, and no `pcall` can contain it — measured
  live, `pcall(DCS.getMissionLoaded)` dies exactly like the bare call (card 19). The
  guarded view is rebuilt fresh per chunk.
- **Config arrives via `_G.DCS_STUDIO`** (`logger_level`), and the `_G` is explicit
  because DCS sandboxes hook chunk environments — a bare `DCS_STUDIO = ...` lands in
  the chunk's own table and never reaches the globals the DLL reads on `require`
  (card 16).

Evidence trail: issue #69 and board cards 16–21 (16 log level, 17 pump staleness,
18 the crash and the ownership rework, 19 the RT guard).

## Testing & coverage

**Four** layers, each runnable on its own command, each gating its own coverage over
an include set that does not overlap the others' ([decision 05](decisions/05-four-disjoint-test-layers-each-at-100.md)).
A gap in one layer can therefore never be masked by another layer happening to
execute the same line. The three JavaScript layers gate at **100% per file**; the
Rust layer gates lines and functions at 100 and regions at 99.5 (the floor is
explained in `.github/workflows/ci.yml`).

| Layer | Command | Tests live in | Gates coverage of |
|---|---|---|---|
| Unit | `npm run test:unit` | `test/unit/**` | `src/core/**`, `media/*-core.js` |
| Integration | `npm run test:integration` | `test/integration/**` | `src/**` minus the hexagon |
| E2E | `npm run test:e2e` | `tests/**` | `media/*.js` in real Chromium |
| Rust | `cargo test --workspace` | `bridge/crates/**` | the bridge workspace (`node scripts/llvm-cov.mjs`) |

`npm test` runs the three JavaScript layers in sequence; `npm run coverage` does
the same with each gate enforced. CI runs one job per layer, plus
`node scripts/llvm-cov.mjs` for the Rust bridge — the locking wrapper, never
`cargo llvm-cov` directly — and a Windows job that re-runs the headless layers on
the shipping OS. Operational detail — prerequisites, and which layer a new test belongs
in — is [docs/02-guides/01-running-the-tests.md](docs/02-guides/01-running-the-tests.md).

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

  This half is no longer a rule anyone has to remember: it is **mechanically
  enforced by `scripts/llvm-cov.mjs`**, which takes an exclusive lock on the
  target directory it is about to build into. A second run fails immediately and
  names the holder, rather than corrupting the first ten minutes in. Go through
  the script — CI does, so CI and a developer's machine run the identical
  command. A run given its own `--target-dir` moves the lock with it and is free
  to proceed in parallel, which is the same escape hatch as before.

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
