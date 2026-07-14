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
      | the bridge DLL is locked (DCS running)  | Bridge DLL is locked — is DCS already running?                      |
      | DCS already launched by this session    | DCS was already launched by DCS Studio.                             |

  Scenario: Inject fails before launch
    Given injection fails for a reason other than a locked DLL
    Then the launch aborts with "Inject failed before launch: <message>"
    And DCS is not started

  Scenario: DCS exits
    Given DCS was launched by the extension
    When the DCS process exits
    Then the bridge files are automatically ejected

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
```
