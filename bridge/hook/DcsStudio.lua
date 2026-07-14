-- DCS Studio GameGUI hook.
-- Loads the dcs_studio_gui native module and serves JSON-RPC over WebSocket on
-- ws://127.0.0.1:25569/ws (plus POST /rpc and GET /health). The request queue
-- is drained once per simulation frame; onSimulationFrame fires at the main
-- menu too (verified live), so RPCs answer from boot — DCS.getModelTime()
-- stays 0 until a mission runs.
--
-- The MISSION scripting state is served by its own DLL (dcs_studio_mission,
-- JSON-RPC on 127.0.0.1:25570): at mission start this hook dispatches a tiny
-- boot snippet into the mission state (net.dostring_in → a_do_script) that
-- require()s the mission DLL — which needs a desanitized MissionScripting.lua
-- (require/package restored). Everything mission-side (eval, REPL, debugger)
-- then talks to 25570 directly; this hook serves gui/server/config/export.
--
-- Installed to <writedir>\Scripts\Hooks\DcsStudio.lua by the extension's
-- inject; both DLLs live at <writedir>\Mods\tech\DcsStudio\bin\.

package.cpath = package.cpath .. ";" .. lfs.writedir() .. "Mods\\tech\\DcsStudio\\bin\\?.dll"

-- Read by the module on require() for configuration.
DCS_STUDIO = { logger_level = "info" }

local ok, bridge = pcall(require, "dcs_studio_gui")
if not ok then
  log.write("DCS-STUDIO", log.ERROR, "load failed: " .. tostring(bridge))
  return
end

local started, err = pcall(function()
  -- Server-side timeout well under the 300s default so a stalled editor
  -- request can never wedge the WS read loop for minutes, but long enough for
  -- console calls that serialize big tables on the sim thread (repl_export
  -- can take tens of seconds).
  local server = bridge.jsonrpc.JsonRpcServer.new({ host = "127.0.0.1", port = 25569, timeout = 30, env = "gui" })
  local router = bridge.jsonrpc.JsonRpcRouter.new()

  router:add_method("ping", function()
    return { pong = true, dcs_time = (DCS.getModelTime and DCS.getModelTime()) or 0 }
  end, {
    description = "Liveness check. dcs_time is mission model time (0 at the main menu).",
  })

  -- A `print` replacement that pipes into the DCS Studio console
  -- (bridge.console) AS WELL AS the original sink, so editor-driven runs
  -- stream their print-debugging into the IDE's Console panel like a
  -- terminal.
  local function console_print_shim(prev)
    return function(...)
      local parts = {}
      for i = 1, select("#", ...) do
        parts[#parts + 1] = tostring(select(i, ...))
      end
      bridge.console.print(table.concat(parts, "\t"))
      if prev then
        pcall(prev, ...)
      end
    end
  end

  -- Run `fn` with `print` captured, restoring it on every path. NOT used by
  -- debug_run: the inner pcall here would unwind a crash before the error
  -- handler could snapshot the live frames — debug_run swaps print around
  -- its own xpcall instead.
  local function with_print_capture(fn, ...)
    local prev = _G.print
    _G.print = console_print_shim(prev)
    local results = { pcall(fn, ...) }
    _G.print = prev
    if not results[1] then
      error(results[2], 0)
    end
    return unpack(results, 2)
  end

  -- Run arbitrary Lua in the GUI/hooks environment and return the result.
  -- localhost-only by the server bind; gives full DCS.*/net.* control
  -- (e.g. start missions, DCS.exitProcess()) for the editor and dev tooling.
  router:add_method("eval", function(params)
    local f, lerr = loadstring(params.code)
    if not f then
      error("loadstring: " .. tostring(lerr))
    end
    return with_print_capture(f)
  end, {
    description = "Run Lua in the GUI/hooks state (DCS.*, net.*) and return the result. print() output streams into console_read. For the mission state use the mission bridge on port 25570.",
    params = { { name = "code", type = "string", required = true, description = "Lua source to run." } },
  })

  -- The IDE's console tail: lines printed since `after` (see console.read).
  router:add_method("console_read", function(params)
    return bridge.console.read(params and params.after or 0)
  end, {
    description = "Lines printed in the GUI state since sequence `after` (0/absent = from the start), as { lines = { { seq, text }, ... }, latest }. The mission bridge has its own ring on port 25570.",
    params = { { name = "after", type = "number", required = false } },
  })

  -- Live type sync (issue #50). The DLL describes its own Lua surface and the
  -- live DCS API as `.d.lua` the editor's lua-analyzer indexes — emitted from
  -- inside the running sim, so hover/diagnostics match the EXACT loaded build,
  -- not an app-build snapshot. Both answer from boot (no mission required);
  -- dump_globals re-introspects `_G` per call, so it reflects whatever the sim
  -- currently exposes. Returned as { dlua = ... } per model TypeDefs.
  router:add_method("emit_dlua", function()
    return { dlua = bridge.emit_dlua() }
  end, {
    description = "The generated EmmyLua (.d.lua) type definitions for this bridge's own Lua surface.",
  })

  router:add_method("dump_globals", function()
    return { dlua = bridge.dump_globals() }
  end, {
    description = "Introspect the live GUI-state API in _G (DCS, Export, net, lfs, log) as dotted .d.lua statements.",
  })

  -- The console/REPL runtime (__DCS_STUDIO_RT) is installed into this state by
  -- the DLL itself; bridge.rt_source carries the same source for injecting
  -- into the remote net states, which self-install it (idempotent via the
  -- version guard) — a fresh state heals itself on the next call.
  --
  -- Environments the console can target HERE. "gui" runs in this hooks env;
  -- server/config/export are DCS Lua states reached synchronously with
  -- net.dostring_in. "mission" is served by the mission bridge on port 25570,
  -- not here — DCS 2.9.27 pointed dostring_in("mission") at a trigger sandbox
  -- whose a_do_script is fire-and-forget (no return value).
  local REPL_ENVS = { gui = true, server = true, config = true, export = true }
  local MISSION_MOVED = "the 'mission' environment is served by the mission bridge on 127.0.0.1:25570 "
    .. "(it runs while a mission is up and needs a desanitized MissionScripting.lua)"

  local function repl_env(params)
    local envname = (params and params.env) or "gui"
    if envname == "mission" then
      error(MISSION_MOVED, 0)
    end
    if not REPL_ENVS[envname] then
      error("unknown environment '" .. tostring(envname) .. "'", 0)
    end
    return envname
  end

  -- Run `__DCS_STUDIO_RT.<callexpr>` in `envname` and return its JSON string.
  -- Remote calls prepend rt_source so a fresh state self-installs the runtime
  -- before answering; refs handed out by inspect/expand live INSIDE that state
  -- and stay valid until repl_clear or the state is torn down.
  local function rt_call(envname, callexpr)
    if envname == "gui" then
      local f = assert(loadstring("return __DCS_STUDIO_RT." .. callexpr))
      return f()
    end
    local src = bridge.rt_source .. "\nreturn __DCS_STUDIO_RT." .. callexpr
    local res = net.dostring_in(envname, src)
    if type(res) ~= "string" or res == "" then
      error("no result from the '" .. envname .. "' environment", 0)
    end
    return res
  end

  -- Envelope decode; remote print() output rides in the envelope and is fed
  -- to the console ring here so it streams to the IDE like local prints.
  local function decode_envelope(envname, res)
    local tbl = bridge.json.decode(res)
    if type(tbl) ~= "table" then
      -- Not our envelope: dostring_in handed back an error string — surface it.
      error("'" .. envname .. "' returned: " .. string.sub(res, 1, 400), 0)
    end
    if type(tbl.prints) == "table" then
      for _, line in ipairs(tbl.prints) do
        bridge.console.print(line)
      end
      tbl.prints = nil
    end
    return tbl
  end

  local function rt_envelope(envname, callexpr)
    return decode_envelope(envname, rt_call(envname, callexpr))
  end

  local REPL_ENV_META = {
    name = "env",
    type = "string",
    required = false,
    description = "gui (default) | server | config | export. mission → use port 25570.",
  }

  -- Env-aware console (the Lua Console panel). repl_eval runs code in the
  -- chosen environment and returns { ok, result?, err? }; repl_inspect /
  -- repl_expand / repl_clear are the lazy table explorer; repl_export writes
  -- the full JSON of a value to a temp file and returns its path — a file, not
  -- a response payload, so a huge export never rides the WebSocket.
  router:add_method("repl_eval", function(params)
    local envname = repl_env(params)
    return rt_envelope(envname, string.format("eval_json(%q)", (params and params.code) or ""))
  end, {
    description = "Console eval in the chosen environment: { ok, result?, err? }.",
    params = { { name = "code", type = "string", required = true }, REPL_ENV_META },
  })

  router:add_method("repl_inspect", function(params)
    local envname = repl_env(params)
    return rt_envelope(envname, string.format("inspect_json(%q)", (params and params.expr) or ""))
  end, {
    description = "Evaluate an expression and register the result for lazy drill-down: { ok, type, value, ref }.",
    params = { { name = "expr", type = "string", required = true }, REPL_ENV_META },
  })

  router:add_method("repl_expand", function(params)
    local envname = repl_env(params)
    return rt_envelope(envname, string.format("expand_json(%d)", (params and params.ref) or 0))
  end, {
    description = "Expand a ref handed out by repl_inspect/repl_expand: { ok, variables }.",
    params = { { name = "ref", type = "number", required = true }, REPL_ENV_META },
  })

  router:add_method("repl_signature", function(params)
    local envname = repl_env(params)
    return rt_envelope(envname, string.format("signature_json(%d)", (params and params.ref) or 0))
  end, {
    description = "Resolve a function ref's real parameter names (never runs the function): { ok, params?, native?, err? }.",
    params = { { name = "ref", type = "number", required = true }, REPL_ENV_META },
  })

  router:add_method("repl_clear", function(params)
    return rt_envelope(repl_env(params), "clear_json()")
  end, {
    description = "Drop every explorer ref held by the chosen environment.",
    params = { REPL_ENV_META },
  })

  local export_n = 0
  local function finalize_export(res)
    if string.sub(res, 1, 4) == "ERR:" then
      error(string.sub(res, 5), 0)
    end
    if string.sub(res, 1, 3) ~= "OK:" then
      error("export failed: " .. string.sub(res, 1, 400), 0)
    end
    local json = string.sub(res, 4)
    local dir = lfs.writedir() .. "Temp\\"
    pcall(lfs.mkdir, dir)
    export_n = export_n + 1
    local path = dir .. "dcs-studio-export-" .. os.time() .. "-" .. export_n .. ".json"
    local fh, ferr = io.open(path, "wb")
    if not fh then
      error("cannot write " .. path .. ": " .. tostring(ferr), 0)
    end
    fh:write(json)
    fh:close()
    return { path = path, bytes = #json }
  end

  router:add_method("repl_export", function(params)
    local envname = repl_env(params)
    local callexpr
    if params and params.ref and params.ref > 0 then
      callexpr = string.format("export_json(nil, %d)", params.ref)
    else
      callexpr = string.format("export_json(%q, nil)", (params and params.expr) or "")
    end
    return finalize_export(rt_call(envname, callexpr))
  end, {
    description = "Write the full JSON of a value (by ref or expression) to a file under <writedir>Temp\\ and return { path, bytes }.",
    params = {
      { name = "expr", type = "string", required = false },
      { name = "ref", type = "number", required = false },
      REPL_ENV_META,
    },
  })

  -- ── Mission bridge boot ──
  -- The mission scripting state is reachable from here only through a
  -- deferred, valueless a_do_script (DCS ≥ 2.9.27) — so instead of tunnelling
  -- work through it, dispatch a tiny boot snippet that require()s the mission
  -- DLL into that state. The DLL then runs its own JSON-RPC server on 25570
  -- and the IDE talks to it directly. require() needs a desanitized
  -- MissionScripting.lua; the snippet reports a clear error into dcs.log
  -- otherwise. Idempotent: __DCS_STUDIO_MISSION_BOOTED guards the re-dispatch
  -- and the mission DLL's server start is reusable across missions.
  local function mission_boot_source()
    local writedir = lfs.writedir()
    return string.format(
      [==[
if not __DCS_STUDIO_MISSION_BOOTED then
  local function fail(msg)
    if env and env.error then env.error("DCS Studio: " .. msg, true) end
  end
  if type(require) ~= "function" or type(package) ~= "table" then
    fail("mission scripting is sanitized (require/package are nil). Run 'DCS Studio: Desanitize MissionScripting.lua', restart DCS, then start the mission again.")
  else
    __DCS_STUDIO_WRITEDIR = %q
    package.cpath = package.cpath .. ";" .. %q
    local ok2, err2 = pcall(require, "dcs_studio_mission")
    if ok2 then
      __DCS_STUDIO_MISSION_BOOTED = true
    else
      fail("cannot load dcs_studio_mission.dll in the mission state: " .. tostring(err2))
    end
  end
end
]==],
      writedir,
      writedir .. "Mods\\tech\\DcsStudio\\bin\\?.dll"
    )
  end

  local boot_at = 0 -- last dispatch (os.clock); rate-limits the frame retry

  local function dispatch_mission_boot()
    boot_at = os.clock()
    -- Fire-and-forget into the real mission state via the trigger sandbox's
    -- a_do_script. No return value: success is observable as port 25570
    -- coming up; failures land in dcs.log via the snippet's env.error.
    pcall(net.dostring_in, "mission", string.format("a_do_script(%q)", mission_boot_source()))
  end

  router:add_method("mission_boot", function()
    dispatch_mission_boot()
    return { dispatched = true }
  end, {
    description = "Re-dispatch the mission-bridge boot into the mission scripting state (fire-and-forget; needs a running mission and a desanitized MissionScripting.lua). Success = port 25570 answering; failures land in dcs.log.",
  })

  -- Debugger for GUI sessions. The engine (__DCS_STUDIO_DBG) is installed
  -- into this state by the DLL; the hook only wires its RPC pump — during a
  -- pause the engine drains this server's queue itself through this router,
  -- because onSimulationFrame cannot fire while the paused chunk holds the
  -- sim thread. Mission sessions talk to the mission bridge on 25570.
  local DBG = assert(__DCS_STUDIO_DBG, "debug engine failed to install in the hooks state")
  DBG.pump = function()
    server:process_rpc(router)
  end

  router:add_method("debug_run", function(params)
    local envname = (params and params.env) or "gui"
    if envname ~= "gui" then
      error(
        "debug env '" .. tostring(envname) .. "' is not served here — mission debugging talks to the mission bridge on 127.0.0.1:25570",
        0
      )
    end
    return DBG.run(
      (params and params.code) or "",
      (params and params.source) or "=debug",
      params and params.pause_on_error == true
    )
  end, {
    description = "Run a chunk under the debugger in the GUI state. Blocks for the whole session (the engine answers this bridge's RPCs itself while running/paused); poll debug_state instead of awaiting this call.",
    params = {
      { name = "code", type = "string", required = true },
      { name = "source", type = "string", required = false, description = 'Chunkname; "=<abs path>" lines breakpoints up with the IDE.' },
      { name = "pause_on_error", type = "boolean", required = false },
      { name = "env", type = "string", required = false, description = "Must be gui here; mission → port 25570." },
    },
  })

  router:add_method("debug_state", function()
    return DBG.state()
  end, {
    description = "Poll the session: { paused, running, snapshot?, error? }. Also the liveness signal that keeps a held pause alive.",
  })

  router:add_method("debug_expand", function(params)
    return DBG.expand((params and params.ref) or 0)
  end, {
    description = "Lazily expand a variables/scope ref from the pause snapshot or the inspector.",
    params = { { name = "ref", type = "number", required = true } },
  })

  router:add_method("debug_eval", function(params)
    return DBG.eval((params and params.frame) or 0, (params and params.expr) or "")
  end, {
    description = "Evaluate an expression in a paused frame (locals → upvalues → globals). A top-level `name = value` assigns for real.",
    params = {
      { name = "frame", type = "number", required = false },
      { name = "expr", type = "string", required = true },
    },
  })

  router:add_method("debug_inspect", function(params)
    return DBG.inspect((params and params.expr) or "")
  end, {
    description = "Evaluate an expression against the live GUI globals and register the result for lazy exploration (no pause needed).",
    params = { { name = "expr", type = "string", required = true } },
  })

  router:add_method("debug_inspect_clear", function()
    return DBG.inspect_clear()
  end, {
    description = "Drop every inspection ref, releasing the held values.",
  })

  -- Replace one source's breakpoints (+ per-line conditions). The registry
  -- lives in THIS DLL's statics: it applies to GUI sessions only — mission
  -- breakpoints go to the mission bridge.
  router:add_method("debug_set_breakpoints", function(params)
    return DBG.set_breakpoints(params)
  end, {
    description = "Replace one source's breakpoints (+ per-line conditions) for GUI sessions: { source, breakpoints = { { line, condition? }, ... } }.",
    params = {
      { name = "source", type = "string", required = true },
      { name = "breakpoints", type = "array", required = true },
    },
  })

  router:add_method("debug_clear_breakpoints", function()
    return DBG.clear_breakpoints()
  end, {
    description = "Drop every breakpoint and condition held by this bridge.",
  })

  router:add_method("debug_continue", function(params)
    local mode = (params and params.mode) or "continue"
    bridge.debug.request_resume(mode)
    return { ok = true, mode = mode }
  end, {
    description = "Resume a paused session: mode continue | step_over | step_into | step_out.",
    params = { { name = "mode", type = "string", required = false } },
  })

  -- Manual Pause / break-all: stop at the next line of debugged code. Delivered
  -- to the busy sim thread via the engine's throttled drain.
  router:add_method("debug_pause", function()
    bridge.debug.request_pause()
    return { ok = true }
  end, {
    description = "Break at the next line of debugged code (manual pause).",
  })

  -- Stop: terminate the running chunk. Request the unwind, and release the pump
  -- with a continue so a paused session resumes straight into the stop check.
  router:add_method("debug_stop", function()
    bridge.debug.request_stop()
    bridge.debug.request_resume("continue")
    return { ok = true }
  end, {
    description = "Terminate the running chunk (unwinds a runaway/looping run).",
  })

  local cb = {}

  function cb.onSimulationFrame()
    server:process_rpc(router) -- drains queued WS/HTTP requests (fires at the menu too)
    -- Self-heal the mission bridge: while a mission is running, re-dispatch
    -- the boot at most every 10s. The snippet is a no-op once booted
    -- (__DCS_STUDIO_MISSION_BOOTED), so this only matters when the first
    -- dispatch ran before the scripting state was ready.
    local mt = (DCS.getModelTime and DCS.getModelTime()) or 0
    if mt > 0 and (os.clock() - boot_at) > 10 then
      dispatch_mission_boot()
    end
  end

  function cb.onSimulationStart()
    dispatch_mission_boot()
  end

  DCS.setUserCallbacks(cb)

  log.write("DCS-STUDIO", log.INFO, "dcs_studio_gui serving JSON-RPC on 127.0.0.1:25569 (mission bridge boots on 25570 at mission start)")
end)
if not started then
  log.write("DCS-STUDIO", log.ERROR, "startup failed: " .. tostring(err))
end
