# dcs-studio-mission — JSON-RPC method reference

<!-- GENERATED FILE — do not edit. Regenerate with `npm run docs:bridge`. -->

> Generated from [`bridge/crates/bridge-mission/openrpc/dcs_studio_mission.openrpc.json`](../bridge/crates/bridge-mission/openrpc/dcs_studio_mission.openrpc.json) (bridge v0.3.0,
> OpenRPC 1.3.2, env `mission`). Do not edit by hand —
> regenerate with `npm run docs:bridge`. See [bridge-api.md](bridge-api.md) for
> transports, ports, and how to fetch this document live via `rpc.discover`.

In-DCS DCS Studio JSON-RPC bridge for the mission environment.

**Servers:** `http://127.0.0.1:25570/rpc` (rpc) · `ws://127.0.0.1:25570/ws` (ws)

## Methods

- **General** — [`dump_globals`](#dump_globals), [`emit_dlua`](#emit_dlua), [`eval`](#eval), [`ping`](#ping)
- **Console (`console_*`)** — [`console_read`](#console_read)
- **Debugger (`debug_*`)** — [`debug_clear_breakpoints`](#debug_clear_breakpoints), [`debug_continue`](#debug_continue), [`debug_eval`](#debug_eval), [`debug_expand`](#debug_expand), [`debug_pause`](#debug_pause), [`debug_run`](#debug_run), [`debug_set_breakpoints`](#debug_set_breakpoints), [`debug_state`](#debug_state), [`debug_stop`](#debug_stop)
- **REPL & explorer (`repl_*`)** — [`repl_clear`](#repl_clear), [`repl_eval`](#repl_eval), [`repl_expand`](#repl_expand), [`repl_export`](#repl_export), [`repl_inspect`](#repl_inspect), [`repl_signature`](#repl_signature)
- **Discovery (`rpc.*`)** — [`rpc.discover`](#rpcdiscover)

## General

### `dump_globals`

Introspect the live mission-state API in _G (env, timer, trigger, world, coalition, ...) as dotted .d.lua statements.

_No parameters._

**Result:** `result` (any)

### `emit_dlua`

The generated EmmyLua (.d.lua) type definitions for this bridge's own Lua surface.

_No parameters._

**Result:** `result` (any)

### `eval`

Run Lua in the mission scripting state and return the result. print() output streams into console_read.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `code` | string | yes | Lua source to run. |

**Result:** `result` (any)

### `ping`

Liveness check. dcs_time is mission model time; it stops advancing while the sim is paused. NOTE: this bridge's queue pump runs on model time too — requests queue (until the 30s server timeout) while the sim is paused or between missions.

_No parameters._

**Result:** `result` (any)

## Console (`console_*`)

### `console_read`

Lines printed in the mission state since sequence `after` (0/absent = from the start), as { lines = { { seq, text }, ... }, latest }. Each bridge has its own ring: mission prints are only readable here.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `after` | number | no | — |

**Result:** `result` (any)

## Debugger (`debug_*`)

### `debug_clear_breakpoints`

Drop every breakpoint and condition held by this bridge.

_No parameters._

**Result:** `result` (any)

### `debug_continue`

Resume a paused session: mode continue | step_over | step_into | step_out.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `mode` | string | no | — |

**Result:** `result` (any)

### `debug_eval`

Evaluate an expression in a paused frame (locals → upvalues → globals). A top-level `name = value` assigns for real.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `frame` | number | no | — |
| `expr` | string | yes | — |

**Result:** `result` (any)

### `debug_expand`

Lazily expand a variables/scope ref from the pause snapshot or the inspector.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | number | yes | — |

**Result:** `result` (any)

### `debug_pause`

Break at the next line of debugged code (manual pause).

_No parameters._

**Result:** `result` (any)

### `debug_run`

Run a chunk under the debugger in the mission state. Blocks for the whole session (the engine answers this bridge's RPCs itself while running/paused); poll debug_state instead of awaiting this call.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `code` | string | yes | — |
| `source` | string | no | Chunkname; "=\<abs path>" lines breakpoints up with the IDE. |
| `pause_on_error` | boolean | no | — |

**Result:** `result` (any)

### `debug_set_breakpoints`

Replace one source's breakpoints (+ per-line conditions): { source, breakpoints = { { line, condition? }, ... } }.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `source` | string | yes | — |
| `breakpoints` | array | yes | — |

**Result:** `result` (any)

### `debug_state`

Poll the session: { paused, running, snapshot?, error? }. Also the liveness signal that keeps a held pause alive.

_No parameters._

**Result:** `result` (any)

### `debug_stop`

Terminate the running chunk (unwinds a runaway/looping run).

_No parameters._

**Result:** `result` (any)

## REPL & explorer (`repl_*`)

### `repl_clear`

Drop every explorer ref held by this state.

_No parameters._

**Result:** `result` (any)

### `repl_eval`

Console eval in the mission state: { ok, result?, err? }.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `code` | string | yes | — |

**Result:** `result` (any)

### `repl_expand`

Expand a ref handed out by repl_inspect/repl_expand: { ok, variables }.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | number | yes | — |

**Result:** `result` (any)

### `repl_export`

Write the full JSON of a value (by ref or expression) to a file under \<writedir>Temp\ and return { path, bytes }.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `expr` | string | no | — |
| `ref` | number | no | — |

**Result:** `result` (any)

### `repl_inspect`

Evaluate an expression and register the result for lazy drill-down: { ok, type, value, ref }.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `expr` | string | yes | — |

**Result:** `result` (any)

### `repl_signature`

Resolve a function ref's real parameter names (never runs the function): { ok, params?, native?, err? }.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | number | yes | — |

**Result:** `result` (any)

## Discovery (`rpc.*`)

### `rpc.discover`

Returns this OpenRPC document.

The OpenRPC service description for this bridge — every JSON-RPC method it serves, with parameters and results. Per the OpenRPC spec, rpc.discover returns the service's OpenRPC document.

_No parameters._

**Result:** `OpenRPC Schema` (object) — The OpenRPC document describing this bridge.
