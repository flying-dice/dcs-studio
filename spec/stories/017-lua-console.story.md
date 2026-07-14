# 017 — Evaluate Lua in the Live Sim (Console)

## Story

> **As a** scripter with DCS running,
> **I want** a REPL that evaluates Lua in any of the sim's environments with history and live `print` streaming,
> **so that** I can poke the live sim state interactively while writing scripts.

## Context

- Entry points: command **"DCS Studio: Open Lua Console"** (`dcs.bridge.console`), the bridge status bar item, and the **DCS Console** launcher row.
- The "DCS Lua Console" panel has two tabs — **Console** (this story) and **Explorer** (story 018) — and an environment picker: GUI (hooks), Mission (scripting env), Server/Config/Export states.

```gherkin
Feature: Lua console

  Background:
    Given the user opens the DCS Lua Console

  Rule: The console always shows connection reality

    Scenario Outline: Status line
      Given the bridge is <state>
      Then the status line shows "<label>"

      Examples:
        | state                      | label                                                |
        | offline                    | Bridge offline — click Launch DCS (with bridge) to connect |
        | connected, at menu         | Connected — at menu (no mission)                     |
        | connected, mission running | Mission running (with "sim t = <N>s")                |

    Scenario: Offline disables execution
      Given the bridge is offline
      Then the Run and Inspect buttons are disabled

    Scenario: Offline shows an inline launch button (story 015)
      Given both bridges are offline
      Then the status line shows a "Launch DCS (with bridge)" button
      When the user clicks it
      Then a "launch" message posts to the extension host, which runs "dcs.bridge.launch"
      And the button reads "Launching…" and is disabled until the bridge connects (or a timeout re-enables it)
      And the button is hidden once either bridge is connected

  Rule: The environment is an explicit choice

    Scenario: Picking an environment
      Then the environment dropdown offers:
        "GUI (hooks)", "Mission (scripting env)",
        "Server state", "Config state", "Export state"
      And the selection persists across sessions (default GUI)

    Scenario: Mission environment without a mission
      Given "Mission (scripting env)" is selected and no mission is running
      Then an inline warning shows "needs a running mission"

  Rule: Evaluation is fast, forgiving and inspectable

    Scenario: Running code
      When the user types Lua and presses Ctrl/Cmd+Enter (or clicks Run)
      Then the input echoes prefixed "›"
      And a successful result renders prefixed "=" —
        nil for no value, raw strings, pretty JSON for tables
      And an error renders prefixed "✖" in red

    Scenario: History
      When the user presses ↑ / ↓ at the edges of the input
      Then previous entries are recalled (up to 100, duplicates collapsed)

    Scenario: print output streams live
      Given any script in the sim calls print(...)
      Then its lines appear in the console output within about a second,
        regardless of which environment printed them

    Scenario: Guidance for first use
      Then the console hints at examples such as
        "return DCS.getVersion()" (GUI) and
        "return #world.getAirbases()" (Mission)
```
