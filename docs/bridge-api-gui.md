# dcs-studio-gui — JSON-RPC method reference

<!-- GENERATED FILE — do not edit. Regenerate with `npm run docs:bridge`. -->

> Generated from [`bridge/crates/bridge-gui/openrpc/dcs_studio_gui.openrpc.json`](../bridge/crates/bridge-gui/openrpc/dcs_studio_gui.openrpc.json) (bridge v0.3.0,
> OpenRPC 1.3.2, env `gui`). Do not edit by hand —
> regenerate with `npm run docs:bridge`. See [bridge-api.md](bridge-api.md) for
> transports, ports, and how to fetch this document live via `rpc.discover`.

In-DCS DCS Studio JSON-RPC bridge for the gui environment.

**Servers:** `http://127.0.0.1:25569/rpc` (rpc) · `ws://127.0.0.1:25569/ws` (ws)

## Methods

- **General** — [`dump_globals`](#dump_globals), [`emit_dlua`](#emit_dlua), [`eval`](#eval), [`mission_boot`](#mission_boot), [`ping`](#ping)
- **Console (`console_*`)** — [`console_read`](#console_read)
- **Unit database (`db_*`)** — [`db_categories`](#db_categories), [`db_export`](#db_export), [`db_unit`](#db_unit), [`db_unit_types`](#db_unit_types), [`db_weapons`](#db_weapons)
- **Debugger (`debug_*`)** — [`debug_clear_breakpoints`](#debug_clear_breakpoints), [`debug_continue`](#debug_continue), [`debug_eval`](#debug_eval), [`debug_expand`](#debug_expand), [`debug_pause`](#debug_pause), [`debug_run`](#debug_run), [`debug_set_breakpoints`](#debug_set_breakpoints), [`debug_state`](#debug_state), [`debug_stop`](#debug_stop)
- **REPL & explorer (`repl_*`)** — [`repl_clear`](#repl_clear), [`repl_eval`](#repl_eval), [`repl_expand`](#repl_expand), [`repl_export`](#repl_export), [`repl_inspect`](#repl_inspect), [`repl_signature`](#repl_signature)
- **Discovery (`rpc.*`)** — [`rpc.discover`](#rpcdiscover)

## General

### `dump_globals`

Introspect the live GUI-state API in _G (DCS, Export, net, lfs, log) as dotted .d.lua statements.

_No parameters._

**Result:** `result` (any)

### `emit_dlua`

The generated EmmyLua (.d.lua) type definitions for this bridge's own Lua surface.

_No parameters._

**Result:** `result` (any)

### `eval`

Run Lua in the GUI/hooks state (DCS.\*, net.\*) and return the result. print() output streams into console_read. For the mission state use the mission bridge on port 25570.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `code` | string | yes | Lua source to run. |

**Result:** `result` (any)

### `mission_boot`

Re-dispatch the mission-bridge boot into the mission scripting state (fire-and-forget; needs a running mission and a desanitized MissionScripting.lua). Success = port 25570 answering; failures land in dcs.log.

_No parameters._

**Result:** `result` (any)

### `ping`

Liveness check. dcs_time is mission model time (0 at the main menu).

_No parameters._

**Result:** `result` (any)

## Console (`console_*`)

### `console_read`

Lines printed in the GUI state since sequence `after` (0/absent = from the start), as { lines = { { seq, text }, ... }, latest }. The mission bridge has its own ring on port 25570.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `after` | number | no | — |

**Result:** `result` (any)

## Unit database (`db_*`)

### `db_categories`

List the DCS unit-database categories.

The real categories inside db.Units (Planes, Helicopters, Ships, Cars, …), shape-detected and filtered (GT_t/Skills and non-unit children are skipped). GUI bridge only; needs DCS loaded.

_No parameters._

**Result:** `categories` (object) — { categories = { { name, entry_key, count }, ... } }

### `db_export`

Dump part (or all) of the DCS database to a JSON file.

Write pretty JSON to \<writedir>Temp\dcs-studio-db-\*.json and return { path, bytes } — a file, not a response payload, so a tens-of-MB dump never rides the WebSocket. `what` = all (default) | weapons | category:\<name> | unit:\<type>. Runs on the sim thread; `all` may stall for seconds (the 30s server timeout is the backstop).

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `what` | string | no | all (default) \| weapons \| category:\<name> \| unit:\<type>. |

**Result:** `export` (object) — { path, bytes }

### `db_unit`

One unit record: curated summary, or the raw record.

Curated: { unit = { type, display_name, category, attributes, country_of_origin, crew_members, perf, guns, pylons } } where pylons carry per-store CLSIDs resolved against db.Weapons. `raw = true` returns the whole record deep-copied through a depth-capped, cycle-safe sanitizer. NB: ME loadout presets are NOT in db — 'payloads' here means pylons + compatible stores.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | string | yes | The unit type name (see db_unit_types). |
| `raw` | boolean | no | Return the whole record (sanitized) instead of the curated view. |

**Result:** `unit` (object) — { unit = { ... }, category?, raw? }

### `db_unit_types`

List unit types (optionally one category, optionally filtered).

Light listing across one or all categories: { units = { { type, display_name, category }, ... }, truncated }. `filter` is a case-insensitive substring over type/display name; capped at 2000 rows.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `category` | string | no | Restrict to one category (name from db_categories). |
| `filter` | string | no | Case-insensitive substring over type/display name. |

**Result:** `units` (object) — { units = { { type, display_name, category }, ... }, truncated }

### `db_weapons`

List weapons/stores from db.Weapons (CLSID + display name).

Light listing of db.Weapons.ByCLSID: { weapons = { { clsid, display_name, name, category }, ... }, truncated }. `filter` is a case-insensitive substring over display name/name/CLSID; capped at 2000 rows.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `filter` | string | no | Case-insensitive substring over display name/name/CLSID. |

**Result:** `weapons` (object) — { weapons = { { clsid, display_name, name, category }, ... }, truncated }

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

Run a chunk under the debugger in the GUI state. Blocks for the whole session (the engine answers this bridge's RPCs itself while running/paused); poll debug_state instead of awaiting this call.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `code` | string | yes | — |
| `source` | string | no | Chunkname; "=\<abs path>" lines breakpoints up with the IDE. |
| `pause_on_error` | boolean | no | — |
| `env` | string | no | Must be gui here; mission → port 25570. |

**Result:** `result` (any)

### `debug_set_breakpoints`

Replace one source's breakpoints (+ per-line conditions) for GUI sessions: { source, breakpoints = { { line, condition? }, ... } }.

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

Drop every explorer ref held by the chosen environment.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `env` | string | no | gui (default) \| server \| config \| export. mission → use port 25570. |

**Result:** `result` (any)

### `repl_eval`

Console eval in the chosen environment: { ok, result?, err? }.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `code` | string | yes | — |
| `env` | string | no | gui (default) \| server \| config \| export. mission → use port 25570. |

**Result:** `result` (any)

### `repl_expand`

Expand a ref handed out by repl_inspect/repl_expand: { ok, variables }.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | number | yes | — |
| `env` | string | no | gui (default) \| server \| config \| export. mission → use port 25570. |

**Result:** `result` (any)

### `repl_export`

Write the full JSON of a value (by ref or expression) to a file under \<writedir>Temp\ and return { path, bytes }.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `expr` | string | no | — |
| `ref` | number | no | — |
| `env` | string | no | gui (default) \| server \| config \| export. mission → use port 25570. |

**Result:** `result` (any)

### `repl_inspect`

Evaluate an expression and register the result for lazy drill-down: { ok, type, value, ref }.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `expr` | string | yes | — |
| `env` | string | no | gui (default) \| server \| config \| export. mission → use port 25570. |

**Result:** `result` (any)

### `repl_signature`

Resolve a function ref's real parameter names (never runs the function): { ok, params?, native?, err? }.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | number | yes | — |
| `env` | string | no | gui (default) \| server \| config \| export. mission → use port 25570. |

**Result:** `result` (any)

## Discovery (`rpc.*`)

### `rpc.discover`

Returns this OpenRPC document.

The OpenRPC service description for this bridge — every JSON-RPC method it serves, with parameters and results. Per the OpenRPC spec, rpc.discover returns the service's OpenRPC document.

_No parameters._

**Result:** `OpenRPC Schema` (object) — The OpenRPC document describing this bridge.
