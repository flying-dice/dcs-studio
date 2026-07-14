# Bridge JSON-RPC API

DCS Studio's live features (Lua console, step debugger, unit-database export,
log tailing) talk to a running sim through two in-process **bridges** — injected
DLLs plus a GameGUI hook. Both speak **JSON-RPC 2.0** over localhost HTTP and
WebSocket, so any local tool, script, or AI agent can drive the sim with plain
`curl` — no extension required.

## The two bridges

**GUI bridge — `dcs_studio_gui.dll`, `127.0.0.1:25569`.** Runs in the GameGUI
hooks state and is up whenever DCS is running (from the main menu onward — no
mission needed). It serves the `gui`, `server`, `config`, and `export`
environments, plus the DCS unit database (`db_*`) and the mission-boot
re-dispatch (`mission_boot`).

**Mission bridge — `dcs_studio_mission.dll`, `127.0.0.1:25570`.** Runs in the
mission scripting state and serves the `mission` environment. It is only
reachable **while a mission is loaded**: the GUI hook boots it a moment after
each mission start, and that boot needs a **desanitized `MissionScripting.lua`**
(`require`/`package` restored — see the MissionScripting panel, command
`dcs.mission.open`). A connection refused on 25570 means "no mission running" (or
a sanitized `MissionScripting.lua` blocked the boot — check `dcs.log`), not a
broken install.

| Bridge  | Port  | Lua envs                    | Alive when            |
| ------- | ----- | --------------------------- | --------------------- |
| GUI     | 25569 | gui, server, config, export | whenever DCS runs     |
| Mission | 25570 | mission                     | only during a mission |

## Browse the API — zero setup

Each bridge describes itself with an **[OpenRPC 1.3.2](https://spec.open-rpc.org/)**
document. The canonical documents are checked into this repo and pinned to the
live surface by tests (see below), so you can browse the full method set — names,
params, and results — without a running sim:

- **GUI bridge (25569):** [`bridge/crates/bridge-gui/openrpc/dcs_studio_gui.openrpc.json`](../bridge/crates/bridge-gui/openrpc/dcs_studio_gui.openrpc.json)
- **Mission bridge (25570):** [`bridge/crates/bridge-mission/openrpc/dcs_studio_mission.openrpc.json`](../bridge/crates/bridge-mission/openrpc/dcs_studio_mission.openrpc.json)

Prefer Markdown? Each document also has a generated, GitHub-viewable **method
reference** — every method with its summary, params table, and result shape,
grouped by prefix:

- **GUI bridge:** [bridge-api-gui.md](bridge-api-gui.md)
- **Mission bridge:** [bridge-api-mission.md](bridge-api-mission.md)

These pages are generated from the OpenRPC JSON by
`scripts/generate-bridge-docs.mjs` — regenerate with `npm run docs:bridge`
after a schema change. A Vitest golden test pins them to the JSON, so CI fails
if they drift.

Open either in the **OpenRPC Playground** for an interactive, rendered view of
every method:

- **GUI:** <https://playground.open-rpc.org/?url=https://raw.githubusercontent.com/flying-dice/dcs-studio/main/bridge/crates/bridge-gui/openrpc/dcs_studio_gui.openrpc.json>
- **Mission:** <https://playground.open-rpc.org/?url=https://raw.githubusercontent.com/flying-dice/dcs-studio/main/bridge/crates/bridge-mission/openrpc/dcs_studio_mission.openrpc.json>

## Fetch the schema live from a running sim

Each bridge also serves its own OpenRPC document at runtime via the standard
**`rpc.discover`** method. The bridge generates it from the exact methods it
registered — never handcrafted — so it is always accurate for the running build.
Endpoints on each port (both transports carry the same JSON-RPC protocol):

- `POST /rpc` — JSON-RPC over HTTP
- `GET /ws` — JSON-RPC over WebSocket
- `GET /health` — identity + liveness (`name`, `env`, `status`, `version`)

Two rules that bite first-time callers:

- The request `id` **must be a string** (or absent for a notification) — a
  numeric id is rejected by the server's parser.
- Requests are answered on the sim thread, so they stall while the sim is paused
  at the escape menu and time out after ~30s; keep the sim in the foreground and
  a mission running (for 25570).

Copy-pasteable — discover the GUI bridge's full surface:

```sh
curl -s http://127.0.0.1:25569/rpc -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"rpc.discover"}'
```

`rpc.discover` returns `{ openrpc, info, servers, methods[] }`. The bridge
identity is in `info` (`title` = service name, `x-dcs-env` = `"gui"` |
`"mission"`, `version` = bridge build); each entry in `methods[]` is an OpenRPC
method object with `name`, `summary`/`description`, `params[]`, and a `result`.
The mission bridge answers the same call on `127.0.0.1:25570/rpc`.

For the practical driving guide — health checks, evaluating Lua in each
environment, the debugger methods, and the `db_*` unit-database surface — see
[`skills/dcs-studio/SKILL.md`](../skills/dcs-studio/SKILL.md).

## The checked-in documents never drift

The two `.openrpc.json` files are **goldens**: bridge tests
(`golden_matches_live_openrpc` in each of `bridge-gui` and `bridge-mission`)
assert the checked-in document byte-for-byte against what `rpc.discover`
generates from the live method registration. On an intentional method-set
change, the companion `regenerate_openrpc_golden` test rewrites the file from the
live surface. The document you browse here is therefore always exactly what a
running bridge of the same version will report.
