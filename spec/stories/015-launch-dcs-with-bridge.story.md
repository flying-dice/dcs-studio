# 015 — Launch DCS with the Bridge

## Story

> **As a** developer starting a live-sim session,
> **I want** one command that injects the bridge and launches DCS, with the connection state visible everywhere,
> **so that** I go from editor to connected sim in one step and always know when the bridge is online.

## Context

- Command: **"DCS Studio: Launch DCS (with bridge)"** (`dcs.bridge.launch`). Requires `dcsStudio.gameInstallPath`. This is the single implementation — every entrypoint below funnels into the same command.
- The bridge serves a WebSocket on `ws://127.0.0.1:25569/ws` (GUI bridge) and `ws://127.0.0.1:25570/ws` (mission bridge, up only while a mission is loaded); the extension pings both every 2 s and reconnects automatically with backoff.
- Connection state is mirrored in the status bar item, the launcher footer (story 002) and the Lua console header (story 017).
- "DCS offline" always means the **GUI bridge** is unreachable — it's up whenever DCS runs, so it is the "is DCS running" signal. A mission bridge that's down while the GUI bridge is up (at the menu, or between missions) is never treated as "DCS offline".
- Beyond the Command Palette, three prominent entrypoints reach the launch command:
  - the status bar item's click dispatcher (below),
  - an inline "Launch DCS (with bridge)" button in the Lua console's offline status line (story 017),
  - the launcher sidebar footer, which mirrors the same connection state (story 002).

```gherkin
Feature: Managed DCS launch

  Scenario: Happy-path launch
    Given "dcsStudio.gameInstallPath" points at a DCS install
    When the user runs "Launch DCS (with bridge)"
    Then the bridge is injected first
    And "DCS.exe --no-launcher" starts detached from the editor
    And a toast reads "Launching DCS with the DCS Studio bridge…"
    And the extension immediately begins reconnect attempts

  Scenario Outline: Launch preconditions
    Given <condition>
    When the user runs the launch command
    Then it aborts with "<message>"

    Examples:
      | condition                               | message                                                             |
      | no game install path configured         | Set dcsStudio.gameInstallPath to your DCS install folder to launch DCS. |
      | DCS.exe missing at the configured path  | DCS.exe not found at <exe>.                                         |
      | the bridge DLL is locked (DCS running)  | A bridge DLL is locked — is DCS already running?                    |
      | DCS already launched by this session    | DCS was already launched by DCS Studio.                             |

  Scenario: Inject fails before launch
    Given injection fails for a reason other than a locked DLL
    Then the launch aborts with "Inject failed before launch: <message>"
    And DCS is not started

  Scenario: DCS exits
    Given DCS was launched by the extension
    When the DCS process exits
    Then the bridge files are automatically ejected

  @chaos
  Scenario: DCS was started from the desktop, outside the editor
    Given DCS is already running, started outside the extension
    When the user runs "Launch DCS (with bridge)"
    Then the assert-inject hits the locked DLL and aborts with
      "A bridge DLL is locked — is DCS already running?"
    And no second sim is spawned
    # Two sims writing the same config and log files corrupts both, so the
    # launch fails closed rather than racing the running one.

  @chaos
  Scenario: The launch command is fired twice in quick succession
    Given no DCS has been launched yet
    When the user triggers "Launch DCS (with bridge)" twice before the first inject finishes
    Then only one DCS.exe is spawned # UNVERIFIED: the tracked child is assigned only after the awaited inject, so two rapid invocations can both pass the "already launched" check — nothing currently serialises them

  @chaos
  Scenario: The already-launched guard outranks a broken configuration
    Given DCS was launched by this session and is still running
    And "dcsStudio.gameInstallPath" has since been cleared
    When the user runs the launch command
    Then it reports "DCS was already launched by DCS Studio."
    And not the missing-install-path error
    # The running-process check is made before any path is resolved.

  @chaos
  Scenario: DCS.exe cannot be started at all
    Given the bridge injected successfully
    When spawning DCS.exe fails (blocked by policy, wrong architecture)
    Then an error reads "Failed to start DCS: <message>"
    And the tracked process is forgotten so a later launch is not blocked
    And the injected bridge files are left in place — a failed spawn does not eject them

  @chaos
  Scenario: DCS exits seconds after starting
    Given DCS was launched by the extension
    When the process exits immediately with a non-zero code
    Then the bridge files are ejected exactly as for a clean quit
    And no error is surfaced — the exit code is not inspected
    And the status bar simply stays "$(debug-disconnect) DCS: offline"

  @chaos
  Scenario: The user closes VS Code while DCS is still running
    When the extension deactivates with a managed DCS process alive
    Then nothing is ejected — the DLLs are locked and removing the hook mid-session
      would break the mission bridge's boot dispatch for the rest of the run
    And because the extension is gone, the process-exit eject never runs either
    And the bridge files stay in the Saved Games folder until the next inject,
      eject or launch

  @chaos
  Scenario: Quit and relaunch within one session
    Given DCS was launched by the extension and the user quits DCS
    Then the bridge is ejected on exit
    When the user runs the launch command again
    Then the bridge is re-injected and DCS starts a second time

  @chaos
  Scenario: An aborted launch still resets the reconnect backoff
    Given the launch aborts for any precondition (no install path, DCS.exe missing,
      a locked DLL, or a DCS already launched)
    When the user runs "dcs.bridge.launch"
    Then the bridge clients are still told to reconnect immediately
    And the backoff drops back to 1 s even though nothing was started

Feature: Prominent launch entrypoints
  The launch command is reachable beyond the Command Palette, wherever the
  offline state is surfaced — every entrypoint reuses "dcs.bridge.launch"
  as its single implementation, preconditions and all.

  Scenario: Status bar click while offline
    Given the GUI bridge is not connected ("DCS: offline")
    When the user clicks the bridge status bar item
    Then a quick pick offers "Launch DCS (with bridge)", "Open Lua Console" and "Inject Bridge"
    And choosing "Launch DCS (with bridge)" runs "dcs.bridge.launch"

  Scenario: Status bar click while online
    Given the GUI bridge is connected (at menu or mission running)
    When the user clicks the bridge status bar item
    Then the Lua console opens directly, with no intermediate quick pick

  Scenario: Console inline launch button
    Given the Lua console is open and both bridges are offline
    Then the status line shows a "Launch DCS (with bridge)" button
    When the user clicks it
    Then "dcs.bridge.launch" runs
    And the button reads "Launching…" and is disabled while the launch is in flight
    And the button disappears once the GUI bridge connects

Feature: Live connection state

  Scenario Outline: Status bar reflects the bridge
    Given the bridge is <state>
    Then the status bar shows "<text>"

    Examples:
      | state                        | text                             |
      | unreachable                  | $(debug-disconnect) DCS: offline |
      | connected, at the main menu  | $(plug) DCS: at menu             |
      | connected, mission running   | $(rocket) DCS: mission <N>s      |

  Scenario: Transition on boot
    Given DCS is loading
    Then the status goes offline → "at menu" once DCS reaches the menu
    And → "mission <N>s" once a mission provides model time

  Scenario: Automatic reconnection
    Given the connection drops
    Then the extension retries with backoff from 1 s up to 10 s
    And recovers without user action when the bridge returns

  @chaos
  Scenario: A mission runs but the mission bridge never comes up
    Given the GUI bridge is connected and reports a mission time above zero
    But the mission bridge on port 25570 is unreachable
    Then the status bar shows "$(warning) DCS: mission (no mission bridge)"
    And the tooltip points at MissionScripting.lua, telling the user to run
      "DCS Studio: Desanitize MissionScripting.lua" and restart the mission
    And this is never rendered as "DCS: offline"

  @chaos
  Scenario: A mission ends under a live session
    Given both bridges are connected with a mission running
    When the mission ends and the mission bridge goes away
    Then the status bar returns to "$(plug) DCS: at menu"
    And "DCS: offline" is not shown — the GUI bridge is still up

  @chaos
  Scenario: DCS is killed mid-session
    Given both bridges are connected
    When DCS is killed and both sockets drop
    Then the status bar shows "$(debug-disconnect) DCS: offline"
    And every in-flight RPC is rejected with "<bridge> disconnected" rather than
      hanging until its timeout
    And the extension keeps retrying on the capped backoff rather than giving up

  @chaos
  Scenario: The status bar is clicked repeatedly while offline
    Given the GUI bridge is not connected
    When the user clicks the bridge status bar item and dismisses the quick pick
    Then no command runs
    And clicking again offers the same three options
```
