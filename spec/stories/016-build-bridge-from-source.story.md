# 016 — Build the Bridge from Source

## Story

> **As a** contributor changing the bridge's Rust code,
> **I want** a command that runs the cargo release build with live output and clear success/failure signals,
> **so that** my modified DLL is picked up by the next inject/launch without leaving the editor.

## Context

- Command: **"DCS Studio: Build Bridge (cargo)"** (`dcs.bridge.build`). The extension ships a prebuilt DLL, so this is only needed after editing `bridge/`.
- Output streams to an Output channel named **"DCS Studio Bridge Build"**; a non-cancellable notification spinner shows while building.

```gherkin
Feature: Cargo bridge build

  Scenario: Successful build
    Given the bridge source is present and the Rust toolchain is on PATH
    When the user runs "Build Bridge (cargo)"
    Then the "DCS Studio Bridge Build" output channel opens
      starting with "$ cargo build --release   (cwd: <bridgeDir>)"
    And a progress notification shows
      "Building DCS bridge (cargo build --release)…"
    And cargo's stdout and stderr stream live into the channel
    And on exit code 0 a toast confirms
      "Bridge built (dcs_studio_gui.dll + dcs_studio_mission.dll). Run DCS Studio: Inject, or Launch DCS, to use them."

  Scenario: The built DLL takes precedence
    Given a release build exists under bridge/target/release
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
    Given this build of the extension does not include the bridge/ source
    Then the command fails with
      "Bridge source (bridge/) is not present in this build."

  @chaos
  Scenario: bridge/ exists but has no Cargo.toml
    Given "bridge/" is present but "bridge/Cargo.toml" is missing
    When the user runs "Build Bridge (cargo)"
    Then the command fails with "Bridge source (bridge/) is not present in this build."
    And no output channel is created and cargo is never spawned
    # Running cargo there would fail with a manifest error that explains nothing.

  @chaos
  Scenario: A failed build leaves the previous DLL deployable
    Given "bridge/target/release" holds DLLs from an earlier successful build
    When the build fails to compile
    Then an error reads
      "Bridge build failed — see the 'DCS Studio Bridge Build' output."
    And the old DLLs are still under "bridge/target/release"
    And the next inject or launch silently deploys those stale DLLs
    # Selection is by existence, never by freshness or by whether the last build
    # succeeded — so a broken build keeps shipping the last good binary.

  @chaos
  Scenario: A stale target directory from an old checkout wins forever
    Given "bridge/target/release" holds DLLs left over from an old checkout
    And the extension has since shipped newer prebuilt DLLs
    When the user injects or launches
    Then the stale built DLLs are deployed instead of the newer shipped ones
    And nothing warns that they are older

  @chaos
  Scenario: The build is killed before it finishes
    Given cargo is terminated by a signal, so it reports no exit code
    When the process ends
    Then the channel ends with "cargo exited with code null"
    And an error reads
      "Bridge build failed — see the 'DCS Studio Bridge Build' output."

  @chaos
  Scenario: A second build started while one is running
    Given a build is already in flight
    When the user runs "Build Bridge (cargo)" again
    Then a second "DCS Studio Bridge Build" output channel is created
    And a second cargo is spawned against the same target directory # UNVERIFIED: nothing in the extension serialises the two builds; cargo's own target-dir file lock is what makes the second wait rather than corrupt the first

  @chaos
  Scenario: The build cannot be cancelled
    Given a cargo build that takes minutes
    Then the progress notification offers no cancel action
    And the command resolves only when cargo exits or fails to start
```
