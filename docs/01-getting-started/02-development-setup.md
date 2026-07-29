# Development setup

## Prerequisites

| Tool | Needed for | Notes |
|---|---|---|
| Node 20 | everything TypeScript | the version CI pins in `.github/workflows/ci.yml` |
| VS Code `^1.125.0` | running the extension | `engines.vscode` in `package.json` |
| Rust (stable) | building the bridge DLLs | plus `llvm-tools-preview` if you want coverage |
| Lua 5.1 dev headers | running the Rust tests off-Windows | `liblua5.1-0-dev` on Debian/Ubuntu |
| Windows | shipping and anything touching DCS | DCS is Windows-only, and so is the path model |

The three TypeScript test layers run fine on Linux and macOS: the domain layer
resolves paths with explicit Windows semantics (`import { win32 as path }`)
regardless of host, so it is deterministic off-Windows.

## The loop

```bash
npm install
npm run compile        # tsc -p ./  →  out/
```

Then press <kbd>F5</kbd> to launch an Extension Development Host.

For a faster loop, `npm run dev` does the whole thing in one command: compiles
once, opens a clean Extension Development Host with only this extension
(`--disable-extensions`) and a scratch workspace under `.dev-sandbox/`, and keeps
`tsc -watch` running. The extension's own dev auto-reload
(`src/devReload.ts`) reloads the host on each rebuild.

To work on a webview without launching VS Code at all, `npm run preview` serves
the `previews/` harness — the same pages the e2e layer drives.

## Building the bridge

```bash
cd bridge
cargo build --release --workspace     # dcs_studio_gui.dll + dcs_studio_mission.dll
```

Both DLLs plus `bridge/lua5.1/lua.lib` are staged into `bridge/prebuilt/` at
release time. That folder is gitignored, and `scripts/check-prebuilt.mjs` runs
from `vscode:prepublish` so a `.vsix` cannot be packaged without it — an
extension missing the payload installs and activates cleanly, then fails only
when a user injects the bridge.

## Quality gates before you push

```bash
npm run lint             # biome check
npm run compile          # tsc over src/
npm run typecheck:tests  # tsc over test/, tests/ and the root configs
npm test                 # unit → integration → e2e, in that order
```

`npm run typecheck:tests` is not redundant with `npm run compile`: vitest and
Playwright transpile through esbuild and Biome does not typecheck, so it is the
only thing that notices a test double drifting from the port it stands in for.

Coverage, and the rules about running the gates, are in
[Running the tests](../02-guides/01-running-the-tests.md).

On the Rust side:

```bash
cd bridge
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```

The workspace lint policy is clippy pedantic plus panic-path restriction lints
(`unwrap_used`, `expect_used` denied). These are not style preferences: the DLLs
run in-process on the DCS sim thread, where a panic takes the user's flight with
it.

## Releasing

GitHub is the source of truth. Bump `version` in `package.json`, tag the commit
`vX.Y.Z`, and push the tag. `.github/workflows/release.yml` then:

1. **calls** `ci.yml` as a gate — nothing is packaged until the full pipeline passes;
2. runs the release guards — the tag must match `package.json`'s version, and if
   `bridge/crates` changed since the previous tag, `bridge/Cargo.toml`'s
   `[workspace.package]` version must have been bumped too;
3. builds the DLLs, packages the `.vsix`, and attaches it — along with both DLLs,
   the hook, and both `openrpc.json` goldens — to a GitHub Release.

Publishing to the VS Code Marketplace is deliberately manual: download the
`.vsix` from the release and upload it.
