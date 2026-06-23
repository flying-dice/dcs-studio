---@meta
--- Generated type definitions for the dcs_studio DLL surface.
--- Do not edit by hand: regenerated from the binding facade.

--- JSON encode/decode helpers.
---@class dcs_studio.json
local dcs_studio_json = {}

--- Encode a Lua value to a JSON string. `opts.pretty = true` indents the output. Returns (nil, err) when the value is not representable (NaN/Inf, a function, …).
---@param value any
---@param opts? table
---@return string? json
---@return string? err
function dcs_studio_json.encode(value, opts) end

--- Encode a Lua value to JSON, coercing sim-unsafe values (NaN/Inf → null, non-UTF-8 strings lossily) instead of failing. Never panics.
---@param value any
---@return string? json
---@return string? err
function dcs_studio_json.safe_encode(value) end

--- Decode a JSON string into a Lua value. Returns (nil, err) on a parse error.
---@param json string
---@return any? value
---@return string? err
function dcs_studio_json.decode(json) end

--- TOML encode/decode helpers (bridged through JSON).
---@class dcs_studio.toml
local dcs_studio_toml = {}

--- Encode a Lua table to a TOML string (sim-safe: NaN/Inf → null, non-UTF-8 lossy). The TOML top level must be a table; a bare array/scalar or a null value returns (nil, err).
---@param value table
---@return string? toml
---@return string? err
function dcs_studio_toml.encode(value) end

--- Decode a TOML string into a Lua table. Returns (nil, err) on a parse error.
---@param toml string
---@return table? value
---@return string? err
function dcs_studio_toml.decode(toml) end

--- Write sim data to disk under the guarded DCS write root (lfs.writedir()).
---@class dcs_studio.file
local dcs_studio_file = {}

--- Write `content` to `path` under lfs.writedir(), truncating. `opts.append = true` appends instead. Refuses a path that escapes the write root.
---@param path string
---@param content string
---@param opts? table
---@return boolean? ok
---@return string? err
function dcs_studio_file.write_text(path, content, opts) end

--- Encode `value` to JSON (sim-safe) and write it to `path` under lfs.writedir(). `opts.pretty = true` indents.
---@param path string
---@param value any
---@param opts? table
---@return boolean? ok
---@return string? err
function dcs_studio_file.write_json(path, value, opts) end

--- Write `rows` (an array of arrays of scalars) as RFC-4180 CSV to `path` under lfs.writedir().
---@param path string
---@param rows any[][]
---@return boolean? ok
---@return string? err
function dcs_studio_file.write_csv(path, rows) end

--- Write `value` to `path` under lfs.writedir(), inferring the format from the extension (.json / .csv / anything else = text), or `opts.format` ("json" | "csv" | "text").
---@param path string
---@param value any
---@param opts? table
---@return boolean? ok
---@return string? err
function dcs_studio_file.dump(path, value, opts) end

--- An open SQLite database handle.
---@class dcs_studio.sqlite.Db
local dcs_studio_sqlite_Db = {}

--- Execute SQL. With `params` (an array of scalars) runs one parameterised statement and returns rows-affected; without, runs a statement batch (e.g. a schema) and returns 0.
---@param sql string
---@param params? any[]
---@return number? changes
---@return string? err
function dcs_studio_sqlite_Db:exec(sql, params) end

--- Run a query and return an array of row tables keyed by column name.
---@param sql string
---@param params? any[]
---@return table[]? rows
---@return string? err
function dcs_studio_sqlite_Db:query(sql, params) end

--- Run `fn` inside BEGIN/COMMIT, rolling back if it raises. `fn` uses the captured database handle.
---@param fn fun(): any
---@return boolean? ok
---@return string? err
function dcs_studio_sqlite_Db:transaction(fn) end

--- Close the database now (also closed when garbage-collected).
function dcs_studio_sqlite_Db:close() end

--- Embedded SQLite — open/query a database under the guarded write root.
---@class dcs_studio.sqlite
local dcs_studio_sqlite = {}

--- Open (creating if needed) a SQLite database at `path` under lfs.writedir(), or ":memory:" for an ephemeral in-memory DB. Returns (nil, err) on a path escape or open failure.
---@param path string
---@return dcs_studio.sqlite.Db? db
---@return string? err
function dcs_studio_sqlite.open(path) end

--- Breakpoint registry the IDE debugger drives over the bridge.
---@class dcs_studio.debug
local dcs_studio_debug = {}

--- Replace the breakpoints for `source` with `lines` (1-based; an empty list clears the source). Returns the number set. Called by the IDE debugger when breakpoints change.
---@param source string
---@param lines number[]
---@return number count
function dcs_studio_debug.set_breakpoints(source, lines) end

--- Whether a breakpoint is set at `source:line` — consulted by the sim's line hook.
---@param source string
---@param line number
---@return boolean paused
function dcs_studio_debug.should_pause(source, line) end

--- Remove every breakpoint.
function dcs_studio_debug.clear_breakpoints() end

--- Return the current breakpoints as a table: source → array of 1-based lines.
---@return table bySource
function dcs_studio_debug.breakpoints() end

--- Record that execution is paused at a breakpoint, with a JSON snapshot of source/line/locals. Called by the line hook.
---@param snapshot string
function dcs_studio_debug.set_paused(snapshot) end

--- Clear the pause (execution resumed). Called by the line hook.
function dcs_studio_debug.clear_paused() end

--- The current pause snapshot (a JSON string), or nil when running.
---@return string? snapshot
function dcs_studio_debug.paused() end

--- Ask the paused line hook to resume: "continue", "step_over", "step_into", or "step_out". Set by the editor/MCP.
---@param mode string
function dcs_studio_debug.request_resume(mode) end

--- The resume mode requested since the last call (consumed by the line hook's pump loop), or nil to stay paused.
---@return string? mode
function dcs_studio_debug.take_resume() end

--- Set (or, with an empty/nil cond, clear) a conditional breakpoint: the hook pauses at `source:line` only when `cond` evaluates truthy in the stopped frame.
---@param source string
---@param line number
---@param cond? string
function dcs_studio_debug.set_condition(source, line, cond) end

--- The condition expression on `source:line`, if any (consulted by the hook).
---@param source string
---@param line number
---@return string? cond
function dcs_studio_debug.condition_at(source, line) end

--- Request a break at the next line of debugged code (manual Pause).
function dcs_studio_debug.request_pause() end

--- Whether a break-all was requested since the last call (consumed by the hook).
---@return boolean pause
function dcs_studio_debug.take_pause() end

--- Request that the running chunk be terminated (Stop unwinds a runaway or looping run, which has no natural end).
function dcs_studio_debug.request_stop() end

--- Whether a stop was requested since the last call (consumed by the hook).
---@return boolean stop
function dcs_studio_debug.take_stop() end

--- Clear all pause/resume/break-all/stop state. Called by the hook at the start of a debug_run so a stale request from a prior session can't bleed in.
function dcs_studio_debug.reset_session() end

--- A namespaced logger writing to the DCS Studio log.
---@class dcs_studio.logger.Logger
local dcs_studio_logger_Logger = {}

--- Create a logger that tags every line with namespace `ns`.
---@param ns string
---@return dcs_studio.logger.Logger
function dcs_studio_logger_Logger.new(ns) end

--- Log at debug level under this logger's namespace.
---@param msg string
function dcs_studio_logger_Logger:debug(msg) end

--- Log at info level under this logger's namespace.
---@param msg string
function dcs_studio_logger_Logger:info(msg) end

--- Log at warn level under this logger's namespace.
---@param msg string
function dcs_studio_logger_Logger:warn(msg) end

--- Log at error level under this logger's namespace.
---@param msg string
function dcs_studio_logger_Logger:error(msg) end

--- Namespaced logging into the DCS Studio log file.
---@class dcs_studio.logger
---@field Logger dcs_studio.logger.Logger # A namespaced logger writing to the DCS Studio log.
local dcs_studio_logger = {}

--- Log a message at debug level.
---@param msg string
---@param ns? string
function dcs_studio_logger.debug(msg, ns) end

--- Log a message at info level.
---@param msg string
---@param ns? string
function dcs_studio_logger.info(msg, ns) end

--- Log a message at warn level.
---@param msg string
---@param ns? string
function dcs_studio_logger.warn(msg, ns) end

--- Log a message at error level.
---@param msg string
---@param ns? string
function dcs_studio_logger.error(msg, ns) end

--- The native WebSocket/HTTP JSON-RPC server inside the DLL.
---@class dcs_studio.jsonrpc.JsonRpcServer
local dcs_studio_jsonrpc_JsonRpcServer = {}

--- Bind a server. `config = { host = string, port = number, timeout? = number }`.
---@param config table
---@return dcs_studio.jsonrpc.JsonRpcServer
function dcs_studio_jsonrpc_JsonRpcServer.new(config) end

--- Drain the queued requests, dispatching each through `router`. Call once per simulation frame.
---@param router dcs_studio.jsonrpc.JsonRpcRouter
---@return boolean
function dcs_studio_jsonrpc_JsonRpcServer:process_rpc(router) end

--- Stop the server (gracefully by default).
---@param graceful? boolean
function dcs_studio_jsonrpc_JsonRpcServer:stop(graceful) end

--- A method-name → Lua-handler table for JSON-RPC dispatch.
---@class dcs_studio.jsonrpc.JsonRpcRouter
local dcs_studio_jsonrpc_JsonRpcRouter = {}

--- Create an empty router.
---@return dcs_studio.jsonrpc.JsonRpcRouter
function dcs_studio_jsonrpc_JsonRpcRouter.new() end

--- Register `handler` under JSON-RPC method `name`.
---@param name string
---@param handler fun(params: any): any
function dcs_studio_jsonrpc_JsonRpcRouter:add_method(name, handler) end

--- The WebSocket/HTTP JSON-RPC server and router.
---@class dcs_studio.jsonrpc
---@field JsonRpcServer dcs_studio.jsonrpc.JsonRpcServer # The native WebSocket/HTTP JSON-RPC server inside the DLL.
---@field JsonRpcRouter dcs_studio.jsonrpc.JsonRpcRouter # A method-name → Lua-handler table for JSON-RPC dispatch.
local dcs_studio_jsonrpc = {}

--- The in-DCS DCS Studio native runtime — loaded by the GameGUI hook via require("dcs_studio").
---@class dcs_studio
---@field name string # The module name ("dcs-studio").
---@field version string # The dcs-bridge crate version this DLL was built from.
---@field json dcs_studio.json # JSON encode/decode helpers.
---@field toml dcs_studio.toml # TOML encode/decode helpers (bridged through JSON).
---@field file dcs_studio.file # Write sim data to disk under the guarded DCS write root (lfs.writedir()).
---@field sqlite dcs_studio.sqlite # Embedded SQLite — open/query a database under the guarded write root.
---@field debug dcs_studio.debug # Breakpoint registry the IDE debugger drives over the bridge.
---@field logger dcs_studio.logger # Namespaced logging into the DCS Studio log file.
---@field jsonrpc dcs_studio.jsonrpc # The WebSocket/HTTP JSON-RPC server and router.
local dcs_studio = {}

--- Return the generated EmmyLua (.d.lua) type definitions for this module.
---@return string
function dcs_studio.emit_dlua() end

--- Introspect the live DCS API in `_G` (DCS, Export, net, lfs, log) and return it as dotted .d.lua statements the editor indexes.
---@return string
function dcs_studio.dump_globals() end

return dcs_studio
