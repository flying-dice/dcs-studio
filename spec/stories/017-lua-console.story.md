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
      Then the Console Run button and the Explorer controls
        (filter, sweep and refresh) are disabled

    Scenario: Offline shows an inline launch button (story 015)
      Given both bridges are offline
      Then the status line shows a "Launch DCS (with bridge)" button
      When the user clicks it
      Then a "launch" message posts to the extension host, which runs "dcs.bridge.launch"
      And the button reads "Launching…" and is disabled until the bridge connects (or a timeout re-enables it)
      And the button is hidden once either bridge is connected

    @chaos
    Scenario: A status push carrying neither bridge
      Given the host posts a status message whose payload names no "gui" and no "mission" bridge
      Then both are treated as offline rather than read off a missing object
      And the status line shows "Bridge offline — click Launch DCS (with bridge) to connect"
      And the "Launch DCS (with bridge)" button is shown
      And no script error is raised inside the webview

    @chaos
    Scenario: DCS is launched, connects, then quits again
      Given both bridges are offline and the user has clicked "Launch DCS (with bridge)"
      And the button reads "Launching…" and is disabled
      When either bridge connects
      Then the button is hidden and the launching guard is dropped
      When DCS later quits and both bridges go offline again
      Then the button is shown, enabled, and reads "Launch DCS (with bridge)" —
        never left stuck on "Launching…"

  Rule: The environment is an explicit choice

    Scenario: Picking an environment
      Then the environment dropdown offers:
        "GUI (hooks)", "Mission (scripting env)",
        "Server state", "Config state", "Export state"
      And the selection persists across sessions (default GUI)

    Scenario: Mission environment without a mission
      Given "Mission (scripting env)" is selected and no mission is running
      Then an inline warning shows "needs a running mission"

    @chaos
    Scenario: Mission environment while MissionScripting.lua is still sanitized
      Given "Mission (scripting env)" is selected
      And the GUI bridge reports a running sim clock while the mission bridge is offline
      Then the status line shows "Mission running — mission bridge offline"
      And the inline warning shows
        "mission bridge offline — desanitize MissionScripting.lua and restart the mission"
        rather than "needs a running mission" — the fix is a different one
      And the Run button is disabled, so no code is sent to a bridge that cannot answer

    @chaos
    Scenario Outline: The picked environment's own bridge is what gates the console
      Given "<selection>" is selected
      And the GUI bridge is <gui> and the mission bridge is <mission>
      Then the inline warning shows "<warning>"
      And the Run button is <run>

      Examples:
        | selection               | gui                | mission   | warning                 | run      |
        | GUI (hooks)             | offline            | connected | GUI bridge offline      | disabled |
        | Server state            | connected, at menu | offline   |                         | enabled  |
        | Mission (scripting env) | connected, at menu | offline   | needs a running mission | disabled |
        | Mission (scripting env) | offline            | connected |                         | enabled  |

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

    @chaos
    Scenario: An empty or whitespace-only snippet is never sent
      When the user clicks Run with only spaces and newlines in the input
      Then no "eval" message is posted to the extension host
      And nothing is echoed into the log — a stray paste is not history

    @chaos
    Scenario: A statement is not an expression
      When the user runs "x = 1"
      Then the runtime compiles it as a statement after "return x = 1" fails to compile
      And it succeeds with no value, rendering "=" nil
      And the missing value is sent as an explicit null, never omitted —
        an absent field would leave the console waiting for a result forever

    @chaos
    Scenario: A chunk that will not compile
      When the user runs "return nil."
      Then an error renders prefixed "✖" reading "loadstring: <the Lua parse error>"
      And nothing reached the sim's runtime

    @chaos
    Scenario: A chunk that prints and then raises
      When the user runs a chunk that calls print(...) twice and then errors
      Then both printed lines still appear in the console
      And the error renders prefixed "✖"
      And the global print is restored in the sim on every path, error or not

    @chaos
    Scenario Outline: Values Lua can produce that JSON cannot
      When the user runs <chunk>
      Then the result renders as <shown> instead of failing the call

      Examples:
        | chunk                                     | shown                          |
        | a function value                          | "function"                     |
        | a userdata value (a live DCS object)      | "userdata"                     |
        | a coroutine                               | "thread"                       |
        | a table that refers back to itself        | "<cycle>" at the looping key   |
        | a table nested deeper than 200 levels     | "<max depth>" past the cap     |

    @chaos
    Scenario: A result the webview cannot stringify
      Given a result value that is itself cyclic once decoded in the webview
      Then the entry still renders (as its string coercion) rather than throwing
      And the console stays usable for the next snippet

    @chaos
    Scenario: A failure with no message still says something
      Given the runtime reports the chunk failed but carries no message
      Then an error entry renders reading "error"
      And the prompt is not left waiting

  Rule: The console never holds the sim, and the sim never wedges the console

    @chaos
    Scenario: A chunk that never returns
      When the user runs an infinite loop
      Then the bridge stops waiting for a response after its 30s server timeout
      And the editor's own call gives up after 35s, rendering
        "GUI bridge call 'repl_eval' timed out" as an error entry
      And the panel stays responsive — the input, history and Explorer all still work,
        and the abandoned call is dropped from the pending map rather than leaked
      But a further snippet queues behind the running chunk on the sim thread,
        which keeps running the user's own loop until it ends
        # UNVERIFIED: no watchdog aborts a runaway repl_eval chunk sim-side;
        # deduced from the RPC drain running Lua handlers on the sim thread

    @chaos
    Scenario: DCS quits mid-evaluation
      Given a snippet is in flight against the GUI bridge
      When DCS exits and the socket closes
      Then the pending call is rejected and renders as "GUI bridge disconnected"
      And the status line flips to
        "Bridge offline — click Launch DCS (with bridge) to connect"
      And the client keeps retrying with backoff, so relaunching DCS restores the console
        with no reopening of the panel

    @chaos
    Scenario: The mission ends mid-evaluation
      Given a snippet is in flight against "Mission (scripting env)"
      When the mission ends and the mission bridge goes down
      Then the pending call renders as "Mission bridge disconnected"
      And the GUI bridge is untouched — switching to "GUI (hooks)" still runs code
      And a mission started afterwards reconnects and re-enables the mission env

    @chaos
    Scenario: The sim restarts under a live console
      Given the console has been tailing print output and reached ring sequence 9
      When DCS restarts and the bridge reconnects with a fresh, empty output ring
      Then the tail cursor resets to 0 rather than staying at 9
      And the new session's print output is shown from its first line

    @chaos
    Scenario: A print poll that fails does not end the stream
      Given a console_read poll rejects (a dropped frame, a momentary timeout)
      Then nothing is rendered for that tick and no error is shown
      And the next tick retries and resumes streaming
```
