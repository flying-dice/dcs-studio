# Dependencies

The **Dependencies** panel is DCS Studio's face over *lua-cargo*, a Cargo-shaped toolchain for DCS Lua mods. It fetches your project's git dependencies and bundles your Lua into a single self-contained file — without ever dropping to a terminal — and streams every step live.

## Where the controls live

The panel header holds three buttons:

- **Fetch** — "Fetch (vendor + lock) the project's dependencies".
- **Bundle** — "Bundle the project's [[bundle]] targets into one file".
- A reload button ("Reload CargoLua.toml") that re-reads the manifest without running anything.

Below the buttons the panel lists the dependencies declared in your manifest, and below that an output area streams the steps of the current run, newest line at the bottom.

## The CargoLua.toml manifest

Everything the panel does is driven by a `CargoLua.toml` file at your project root:

```toml
[package]
name = "my-mod"
version = "0.1.0"

[dependencies]
moose = { github = "FlightControl-Master/MOOSE", tag = "v2.9.0" }
util  = { github = "me/lua-util" }

[[bundle]]
name = "my-mod.lua"
path = "src/main.lua"
```

- **`[dependencies]`** — each row names a dependency and points it at a GitHub `owner/repo`. Pin it to exactly one of `branch`, `tag`, or `rev`; if you give none, the remote's default branch is used.
- **`[[bundle]]`** — one or more bundle targets, each with a `name` (the output file) and a `path` (the entry script). You can declare several.
- The parser is tolerant: keys it does not recognise are ignored.

## Declaring a dependency

The panel lists your dependencies (name and repository) but does not add them itself. There are two ways to add one:

- **From the Marketplace** — choose *Add as dependency* on a library's page. It writes the row into `CargoLua.toml` and immediately fetches it, with progress shown right here in this panel. See the **Marketplace** guide.
- **By hand** — add the row to `[dependencies]` yourself, click the reload button to refresh the list, then click **Fetch**.

When no dependencies are declared the panel reads: *"No dependencies — add one from the Marketplace, or declare it in CargoLua.toml, then Fetch."*

## Fetch: vendoring and the lockfile

Clicking **Fetch** resolves every declared dependency by shelling out to the `git` already installed on your machine. For each dependency it clones (or, if already present, fetches) into `.lua-cargo/deps/<name>` inside your project, checks out the pinned ref, and records the resolved commit SHA in `CargoLua.lock`.

- The lockfile is written sorted by name, so its contents are deterministic. Commit it, and another machine that fetches the same project checks out the exact same revisions.
- A dependency pinned to a `tag` or `rev` that the lock and the on-disk checkout already satisfy is left untouched. A `branch` (or default-branch) dependency re-fetches and may advance to the branch tip.
- On a successful fetch the workspace re-indexes, so a freshly added dependency's modules light up at once — `require("dep")` resolves and its symbols autocomplete and hover without reopening the project.
- `git` must be on the `PATH`. If it is missing, the fetch fails with `git not found on PATH`.

## Bundle: amalgamating your scripts

Clicking **Bundle** walks the `require(...)` graph from each `[[bundle]]` entry script, wraps every reachable module's source verbatim behind a single `__require` shim, and emits one self-contained Lua 5.1 file into the project's `dist/` folder.

- Module sources are copied verbatim — no code is run and no syntax tree is rewritten — so bundling is sandbox-safe.
- A `require` that resolves to neither a local module nor a vendored dependency (a DCS or host built-in such as the sim globals) becomes a warning, never a failure: the in-sim `require` resolves it at runtime.

## How modules resolve

A `require("a.b")` is mapped to `a/b.lua` and then `a/b/init.lua`, searched in priority order: the requiring file's own directory, the project root, `<project>/src`, the vendor parent (so a bare `require("moose")` finds `.lua-cargo/deps/moose/init.lua`), then each vendored dependency's root and its `src`/`lua`. The first match wins; any other match is reported as a shadowing collision. The editor and the bundler share this one resolver, so what resolves in the editor resolves identically in the bundle.

## Live output and status

- Fetch and Bundle both stream each step into the output area as it happens; the status on the right reads `fetching…` or `bundling…` while running, then a one-line summary, or `failed: …` on error.
- Only one lua-cargo task runs at a time. Asking for a second Fetch or Bundle while one is in flight is refused with a busy message, so runs never race the vendor cache.

## Tips

- Vendored dependencies get full editor intelligence — completion, hover, cross-file resolution — like first-party code, while their own internal unresolved-`require` warnings are suppressed so a large library does not flood your diagnostics.
- To compile a Rust project instead, see the **Build** guide. To ship a finished mod as a signed artifact, see the **Packages** guide.
