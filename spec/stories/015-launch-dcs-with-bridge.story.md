# 015 — Launch DCS with the Bridge

## Story

> **As a** developer starting a live-sim session,
> **I want** one command that injects the bridge and launches DCS, with the connection state visible everywhere,
> **so that** I go from editor to connected sim in one step and always know when the bridge is online.

## Context

- Command: **"DCS Studio: Launch DCS (with bridge)"** (`dcs.bridge.launch`). Requires `dcsStudio.gameInstallPath`.
- The bridge serves a WebSocket on `ws://127.0.0.1:25569/ws` (localhost only); the extension pings every 2 s and reconnects automatically with backoff.
- Connection state is mirrored in the status bar item, the launcher footer (story 002) and the Lua console header (story 017).

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
