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

-- Read by the module on require() for configuration. Kept at the DLL's own
-- default (and the mission bridge's): anything chattier logs every RPC response
-- body on the sim thread into a non-rolling file, and a paused debug session
-- polls debug_state four times a second carrying the whole snapshot each time.
--
-- Written through _G explicitly, and that is load-bearing (card 16): DCS runs
-- Scripts/Hooks chunks with their own environment table, so a bare
-- `DCS_STUDIO = ...` here lands in THAT table and never reaches the globals the
-- DLL reads with lua_getglobal — which is exactly what a live session measured
-- (DCS_STUDIO nil in the GUI state, the bridge logging at TRACE). Reads still
-- pass through to _G, which is why `package.cpath` below works either way.
_G.DCS_STUDIO = { logger_level = "warn" }

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
  --
  -- `serve` hands back userdata that OWNS the server; this state parks it in the
  -- frame callbacks below (DCS.setUserCallbacks holds them for the life of the
  -- GameGUI state, which is the life of the process), so the listener lives
  -- exactly as long as the state that asked for it. Same pattern as the mission
  -- bridge — card 18's Lua-lifecycle directive — with the same shape here even
  -- though this state is never destroyed before DCS exits, so behaviour is
  -- unchanged: uniformity, not a fix.
  local server = bridge.jsonrpc.serve({ host = "127.0.0.1", port = 25569, timeout = 30, env = "gui" })
  local router = bridge.jsonrpc.JsonRpcRouter.new()

  -- Debugger for GUI sessions. The engine (__DCS_STUDIO_DBG) is installed
  -- into this state by the DLL; the hook wires its RPC pump — during a
  -- pause the engine drains this server's queue itself through this router,
  -- because onSimulationFrame cannot fire while the paused chunk holds the
  -- sim thread. Mission sessions talk to the mission bridge on 25570.
  --
  -- nil when the engine DECLINED to install (a state without debug/coroutine —
  -- it is designed to, and the DLL only warns). That must cost the user
  -- breakpoints here, nothing else: insisting on it inside this startup pcall
  -- would cost them the server, the methods and the whole GUI bridge. The
  -- individual debug_* methods answer a clear error instead (need_debugger in
  -- gui_methods.lua), exactly as the mission side does.
  local DBG = __DCS_STUDIO_DBG
  if DBG then
    DBG.pump = function()
      server:process_rpc(router)
    end
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

  -- Seconds between repeats of a callback's error; onSimulationFrame runs 60x a
  -- second forever, so an unthrottled report of a persistent fault would write
  -- ~200k lines a minute into dcs.log.
  local CALLBACK_ERROR_INTERVAL = 10

  -- One independent throttle per callback. Independent deliberately: a frame
  -- fault firing 60x a second must not swallow the one report a mission start
  -- gets, and vice versa — a shared stamp would make whichever fires first hide
  -- the other for ten seconds.
  --
  -- os.clock, like the boot-dispatch rate limit in gui_methods.lua: these run at
  -- the main menu too, where there is no model time to measure.
  local function reporter(what)
    local reported_at = nil
    return function(err)
      local now = os.clock()
      if not reported_at or (now - reported_at) > CALLBACK_ERROR_INTERVAL then
        reported_at = now
        log.write("DCS-STUDIO", log.ERROR, what .. ": " .. tostring(err))
      end
    end
  end

  local report_frame_error = reporter("simulation frame error")
  local report_start_error = reporter("simulation start error")

  -- The frame body, hoisted out of the callback rather than built inside it.
  -- pcall needs a function value, and written inline that is a fresh closure
  -- constructed 60 times a second for the entire life of the process — a
  -- garbage allocation per frame, forever, for a function that closes over
  -- nothing that changes. One named upvalue costs one allocation, once.
  local function drain_frame()
    server:process_rpc(router) -- drains queued WS/HTTP requests (fires at the menu too)
    reg.mission_boot_tick() -- self-heals the mission bridge boot while a mission runs
  end

  -- BOTH callbacks are protected, and for the same reason mission_init.lua's
  -- pump is: these are C++ entry points. DCS calls them from its own dispatcher,
  -- which has nothing to catch a raise, so a fault in the live globals they
  -- touch (DCS.getModelTime, lfs.writedir, net.dostring_in) would vanish with no
  -- bridge-side diagnostic at all — the editor just sees a dead bridge.
  function cb.onSimulationFrame()
    -- A raise here also SKIPS the RPC drain, so the bridge is up and answering
    -- nothing until it is fixed.
    local drained, frame_err = pcall(drain_frame)
    if not drained then
      report_frame_error(frame_err)
    end
  end

  function cb.onSimulationStart()
    -- dispatch_mission_boot reaches lfs.writedir and net.dostring_in — both live
    -- globals, in a state shared with every other mod. Unprotected, a raise from
    -- either escaped straight into DCS's dispatcher: the mission bridge silently
    -- never booted and nothing anywhere said why.
    local dispatched, start_err = pcall(reg.dispatch_mission_boot)
    if not dispatched then
      report_start_error(start_err)
    end
  end

  DCS.setUserCallbacks(cb)

  log.write("DCS-STUDIO", log.INFO, "dcs_studio_gui serving JSON-RPC on 127.0.0.1:25569 (mission bridge boots on 25570 at mission start)")
end)
if not started then
  log.write("DCS-STUDIO", log.ERROR, "startup failed: " .. tostring(err))
end
