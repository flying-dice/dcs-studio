# 016 — Build the Bridge from Source

## Story

> **As a** contributor changing the bridge's Rust code,
> **I want** a command that runs the cargo release build with live output and clear success/failure signals,
> **so that** my modified DLL is picked up by the next inject/launch without leaving the editor.

## Context

- Command: **"DCS Studio: Build Bridge (cargo)"** (`dcs.bridge.build`). The extension ships a prebuilt DLL, so this is only needed after editing `native/`.
- Output streams to an Output channel named **"DCS Studio Bridge Build"**; a non-cancellable notification spinner shows while building.

```gherkin
Feature: Cargo bridge build

  Scenario: Successful build
    Given the bridge source is present and the Rust toolchain is on PATH
    When the user runs "Build Bridge (cargo)"
    Then the "DCS Studio Bridge Build" output channel opens
      starting with "$ cargo build --release   (cwd: <nativeDir>)"
    And a progress notification shows
      "Building DCS bridge (cargo build --release)…"
    And cargo's stdout and stderr stream live into the channel
    And on exit code 0 a toast confirms
      "Bridge built. Run DCS Studio: Inject, or Launch DCS, to use it."

  Scenario: The built DLL takes precedence
    Given a release build exists under native/target/release
    When the user next injects or launches (stories 014/015)
    Then the freshly built DLL is deployed instead of the shipped one

  Scenario: Build failure
    Given the build exits non-zero
    Then an error reads
      "Bridge build failed — see the 'DCS Studio Bridge Build' output."
    And the channel ends with "cargo exited with code <code>"

  Scenario: cargo is not installed
    Given cargo cannot be started
    Then the channel logs "Failed to start cargo: <message>"
    And an error reads
      "Could not run cargo. Is the Rust toolchain installed and on PATH?"

  Scenario: Source not shipped
    Given this build of the extension does not include the native/ source
    Then the command fails with
      "Bridge source (native/) is not present in this build."
```
