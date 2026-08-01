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

- **GUI bridge (25569):** [`bridge/crates/bridge-gui/openrpc/dcs_studio_gui.openrpc.json`](../../bridge/crates/bridge-gui/openrpc/dcs_studio_gui.openrpc.json)
- **Mission bridge (25570):** [`bridge/crates/bridge-mission/openrpc/dcs_studio_mission.openrpc.json`](../../bridge/crates/bridge-mission/openrpc/dcs_studio_mission.openrpc.json)

Prefer Markdown? Each document also has a generated, GitHub-viewable **method
reference** — every method with its summary, params table, and result shape,
grouped by prefix:

- **GUI bridge:** [02-bridge-api-gui.md](02-bridge-api-gui.md)
- **Mission bridge:** [03-bridge-api-mission.md](03-bridge-api-mission.md)

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
- `GET /health` — identity + pump liveness + queue depth (`name`, `env`,
  `status`, `version`, `pump_idle_ms`, `pump_stalled`, `queue_depth`,
  `queue_capacity`)

Both transports cap a body at **32 MB** — stated by the bridge rather than
inherited from the web framework's defaults (which are 2 MB for HTTP and 64 KB
for a WebSocket frame). Over that, `POST /rpc` answers `413` from the
`Content-Length` alone and the WebSocket session is closed. Nothing the editor
sends comes near it: anything that would genuinely be tens of megabytes
(`db_export`, `repl_export`) writes a file and returns its path instead.

Three rules that bite first-time callers:

- The request `id` **must be a string** (or absent for a notification) — a
  numeric id is rejected by the server's parser.
- Requests are answered on the sim thread, so they cannot be served while the sim
  is not running its callbacks (paused at the escape menu, held at a breakpoint,
  loading, or between missions on 25570). Keep the sim in the foreground and a
  mission running (for 25570).
- **`status: "OK"` is about the listener, not the sim.** `/health` is answered by
  the bridge's HTTP worker and needs nothing from Lua, so it answers in 1-2 ms
  even when no request can be dispatched at all. The two fields that tell you
  whether a call will actually be *served* are `pump_idle_ms` (how long since the
  Lua-side queue drain last ran) and `pump_stalled` (whether that is now past the
  refusal threshold), plus `queue_depth` against `queue_capacity` — a bridge can
  be listening AND pumping and still be behind, and a depth climbing across
  successive probes is the only warning before the refusals start. Reachability
  is not liveness — read these, not the socket.

### `-32002 sim not pumping`

When the queue has gone unpumped for longer than the threshold (2 s by default),
an arriving request is refused **immediately** with an implementation-defined
error instead of being parked until the request timeout:

```json
{ "jsonrpc": "2.0", "id": "1", "error": {
  "code": -32002, "message": "sim not pumping",
  "data": "the gui bridge's queue has not been drained for 4310 ms — …" } }
```

The same code, with `"message": "queue full"`, means the other half of the same
problem: the queue has reached its 256-entry cap. A request carrying an id is
never dropped to make room — it is refused like this, and nothing already queued
is displaced. A *notification* is what gives way, oldest first, because it has
no caller waiting; the drop is logged at `warn`, and a notification arriving at a
queue full of undroppable requests gets `503` rather than a `202` that would lose
it silently.

Nothing is broken when you see either one, and nothing needs reconnecting: the
bridge is listening and serves again on the very next frame it is pumped. Treat it as "not
right now" — the sim is paused, loading, or a debug session or long call owns the
sim thread. It is distinct from `-32001 bridge torn down`, which means the Lua
state that would have answered has gone away (mission end).

Both bridges have their own pump, and they stall independently: a held **mission**
breakpoint stops the GUI bridge's per-frame drain while the mission bridge keeps
serving `debug_state`/`debug_continue` from the debug engine's own drain — so a
`-32002` from 25569 during a debug pause is expected while 25570 stays live.

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
[`skills/dcs-studio/SKILL.md`](../../skills/dcs-studio/SKILL.md).

## The checked-in documents never drift

The two `.openrpc.json` files are **goldens**: bridge tests
(`golden_matches_live_openrpc` in each of `bridge-gui` and `bridge-mission`)
assert the checked-in document byte-for-byte against what `rpc.discover`
generates from the live method registration. On an intentional method-set
change, re-running the suite with `DCS_STUDIO_REGENERATE_GOLDENS=1` rewrites the
file from the live surface. The document you browse here is therefore always exactly what a
running bridge of the same version will report.
