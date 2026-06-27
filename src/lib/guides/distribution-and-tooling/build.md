# Build

The **Build** action compiles the open project and streams the compiler's output, line by line, into the IDE's Output tool window. The same panel can also install and uninstall the built project, so you can go from source to a deployed mod without leaving it.

## Where the controls live

The **Build**, **Install**, and **Uninstall** buttons sit in the header of the **Output** tool window — the panel at the bottom of the IDE where build results appear. All three are disabled until a project is open. A short status line on the right of the header reports what is happening.

## Running a build

1. Open the project you want to build.
2. Click **Build** (its tooltip reads "Build the open project"). While a build is in flight the button shows a spinner and is disabled, so two builds can never overlap.
3. Output appears in the panel below, one line per compiler message, with the newest line at the bottom; the view scrolls to follow it.
4. When the run ends, the status on the right shows either `build succeeded` or `build failed (exit N)`, where `N` is the process exit code.

For a Rust project this runs `cargo build --release` against the project root, and every line cargo writes to stdout or stderr appears in the panel as it is emitted.

## What counts as a Rust project

A project builds with cargo whenever a `Cargo.toml` sits at its root — not only projects scaffolded from the rust-dll template. Any Rust project at the root is detected and built the same way.

A hint line at the top of the output area shows the toolchain a build would use, for example:

```
cargo: cargo 1.77.0 (...)
```

If cargo cannot be found it instead reads:

```
cargo: not found — install Rust via rustup.rs
```

## Non-Rust projects (lua-script and blank)

A lua-script or blank project has nothing to compile. Building one succeeds immediately as a no-op — no toolchain is required — and the status line reads `nothing to build`. This is expected, not an error.

For Lua mods, the equivalent tooling is fetching dependencies and bundling your scripts; see the **Dependencies** guide.

## Toolchain detection

Before a build, DCS Studio probes the machine for its Rust toolchain by running `cargo --version` and `rustup --version`. A tool that is not on the `PATH` is simply reported as missing — detection never fails or crashes the IDE.

If you run **Build** on a Rust project on a machine without cargo, the build fails with guidance to install Rust via rustup, and the IDE stays responsive. Install Rust from rustup.rs, then build again.

## Install and Uninstall

These two buttons act on the project's deployment rules, not on the compiler:

- **Install** (tooltip "Install per dcs-studio.toml [[install]] rules") copies the project's files to their DCS destinations as declared in its `dcs-studio.toml`.
- **Uninstall** (tooltip "Remove installed files") removes what was installed. It is enabled only when the project is currently installed.

A small status indicator between the buttons reports the deployment state as `not installed`, `installed`, or `installed · outdated` (installed, but a source file has since changed). For the full mapping of sources to DCS roots, see the **Installer** guide.

## Tips and troubleshooting

- **Buttons greyed out?** No project is open, or a build/install is already running.
- **`build failed (exit N)`** — read the streamed cargo errors directly above the status line; the failing message is usually near the bottom.
- **Packaging a build to share it** is a separate step — see the **Packages** guide.
