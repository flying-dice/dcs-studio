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
-- The JSON-RPC method set is registered by bridge.register_methods (embedded in
-- the DLL, shared with the OpenRPC golden test); this hook only builds the
-- server/router, injects the DCS-API touchpoints, and wires the callbacks.
--
-- Installed to <writedir>\Scripts\Hooks\DcsStudio.lua by the extension's
-- inject; both DLLs live at <writedir>\Mods\tech\DcsStudio\bin\.

package.cpath = package.cpath .. ";" .. lfs.writedir() .. "Mods\\tech\\DcsStudio\\bin\\?.dll"

-- Read by the module on require() for configuration.
-- TODO: clean-code - 0.7 - KISS: at "info" the server logs every RPC response
-- body, and a debug session polls debug_state every 250ms — each response
-- carrying the whole pause snapshot — into a non-rolling log file, written on
-- the sim thread. The DLL default is warn and the mission bridge does not
-- override it; this should say "warn" too.
DCS_STUDIO = { logger_level = "info" }

local ok, bridge = pcall(require, "dcs_studio_gui")
if not ok then
  log.write("DCS-STUDIO", log.ERROR, "load failed: " .. tostring(bridge))
  return
end

local started, err = pcall(function()
  -- Server-side timeout well under the 300s default so a stalled editor
  -- request can never wedge the WS read loop for minutes, but long enough for
  -- console calls that serialize big tables on the sim thread (repl_export and
  -- db_export can take tens of seconds).
  local server = bridge.jsonrpc.JsonRpcServer.new({ host = "127.0.0.1", port = 25569, timeout = 30, env = "gui" })
  local router = bridge.jsonrpc.JsonRpcRouter.new()

  -- Debugger for GUI sessions. The engine (__DCS_STUDIO_DBG) is installed
  -- into this state by the DLL; the hook wires its RPC pump — during a
  -- pause the engine drains this server's queue itself through this router,
  -- because onSimulationFrame cannot fire while the paused chunk holds the
  -- sim thread. Mission sessions talk to the mission bridge on 25570.
  -- TODO: clean-code - 0.75 - PANIC: debug_engine.lua is designed to DECLINE in
  -- a state without `debug`/`coroutine` (DCS already strips debug.getupvalue
  -- here), and lib.rs only warns. This assert turns that decline into a total
  -- bridge failure inside the startup pcall: no server, no methods, no GUI
  -- bridge at all. mission_init.lua handles the same case with a plain
  -- `if DBG then` plus need_debugger() guards; the GUI path should match.
  local DBG = assert(__DCS_STUDIO_DBG, "debug engine failed to install in the hooks state")
  DBG.pump = function()
    server:process_rpc(router)
  end

  -- Register every JSON-RPC method (ping/eval/console/repl/debug/db/…) — the
  -- shared chunk closes over the injected touchpoints, so the same registration
  -- runs live here and headless in the OpenRPC golden test.
  local reg = bridge.register_methods(router, {
    bridge = bridge,
    DBG = DBG,
    RT = __DCS_STUDIO_RT,
  })

  local cb = {}

  -- TODO: clean-code - 0.5 - PANIC: unprotected, 60x/second, forever. Anything
  -- raised by mission_boot_tick's live globals (DCS.getModelTime, lfs.writedir,
  -- net.dostring_in) goes into DCS's callback dispatcher with no bridge-side
  -- diagnostic and skips the RPC drain, so the editor sees an unexplained dead
  -- bridge. mission_init.lua pcalls its equivalent pump and reports; so should
  -- this — with the log line rate-limited so a persistent fault cannot flood.
  function cb.onSimulationFrame()
    server:process_rpc(router) -- drains queued WS/HTTP requests (fires at the menu too)
    reg.mission_boot_tick() -- self-heals the mission bridge boot while a mission runs
  end

  function cb.onSimulationStart()
    reg.dispatch_mission_boot()
  end

  DCS.setUserCallbacks(cb)

  log.write("DCS-STUDIO", log.INFO, "dcs_studio_gui serving JSON-RPC on 127.0.0.1:25569 (mission bridge boots on 25570 at mission start)")
end)
if not started then
  log.write("DCS-STUDIO", log.ERROR, "startup failed: " .. tostring(err))
end
