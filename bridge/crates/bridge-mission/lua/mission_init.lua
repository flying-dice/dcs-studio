-- DCS Studio mission bridge init. Embedded in dcs_studio_mission.dll and run
-- by luaopen on EVERY mission load (fresh mission Lua state each time; the
-- DLL image and its statics persist for the process lifetime). Receives the
-- bridge exports table as the chunk argument.
--
-- Starts (or reuses) this DLL's JSON-RPC server on 127.0.0.1:25570, registers
-- the mission-state method set, and schedules the queue pump on model time —
-- the DCS-gRPC pattern. While a debug_run holds the sim thread, the debug
-- engine serves the editor itself (D.pump → process_queue), so the scheduled
-- pump being blocked is fine.
--
-- It also registers the TEARDOWN that releases this state before DCS destroys
-- it — see the "Teardown" section below and issue #69.
local bridge = ...

-- The "DCS Studio: " env.error/env.info log prefix is shared BY LOCKSTEP with
-- the mission-boot snippet in gui_methods.lua (mission_boot_source). It can't be
-- factored out: that snippet runs in the bare trigger sandbox before this DLL
-- (and rt.lua) exists there. Keep the literals identical by hand.
local function report_error(msg)
  if type(env) == "table" and env.error then
    env.error("DCS Studio: " .. msg, true)
  end
  pcall(bridge.logger.error, msg)
end

local function report_info(msg)
  if type(env) == "table" and env.info then
    env.info("DCS Studio: " .. msg)
  end
  pcall(bridge.logger.info, msg)
end

-- Start the server, or reuse the one from a previous mission (which also
-- drops any requests stranded in its queue between missions).
local server_ok, started = pcall(bridge.jsonrpc.serve, {
  host = "127.0.0.1",
  port = 25570,
  timeout = 30,
  env = "mission",
})
if not server_ok then
  report_error("mission bridge server failed to start: " .. tostring(started))
  return
end

-- Fresh mission: a stale pause/resume/stop from a mission that ended
-- mid-session must not bleed into this one. Breakpoints persist deliberately
-- (the IDE re-sends the full set per source anyway).
bridge.debug.reset_session()

local DBG = __DCS_STUDIO_DBG -- installed by bootstrap; nil if this state lacks the debug library
local RT = assert(__DCS_STUDIO_RT, "console runtime failed to install in the mission state")

local router = bridge.jsonrpc.JsonRpcRouter.new()

-- Register every JSON-RPC method (ping/eval/console/repl/debug/…) — the shared
-- chunk (bridge.register_methods, embedded in the DLL) closes over the injected
-- touchpoints, so the same registration runs live here and headless in the
-- OpenRPC golden test.
bridge.register_methods(router, {
  bridge = bridge,
  DBG = DBG,
  RT = RT,
})

-- ── Teardown (card 18 / issue #69) ──
-- DCS destroys this Lua state on every mission unload, and the router above
-- holds a live reference into it for every method it registered. Left alone,
-- those references are dropped by the router userdata's __gc — which Lua 5.1
-- runs DURING lua_close, handing registry references back to a state that is
-- already tearing down. So release them while the state is still whole, and
-- leave __gc an empty router.
--
-- torn_down also stops the pumps: a released router answers nothing, and
-- dispatching into a state DCS is unloading is the behaviour being removed.
local torn_down = false

local function teardown(why)
  if torn_down then
    return
  end
  torn_down = true
  local ok, released, failed = pcall(bridge.jsonrpc.teardown, router, why)
  if ok then
    report_info(string.format("mission bridge released %s Lua handler(s) and failed %s queued request(s) on %s",
      tostring(released), tostring(failed), tostring(why)))
  else
    -- Never fatal: this runs on DCS's way out of the mission, and a raise here
    -- would land in the engine's event dispatcher with nothing to catch it.
    report_error("mission bridge teardown failed: " .. tostring(released))
  end
end

-- Reachable by name so the GUI bridge (or an operator, over RPC) can trigger
-- the release explicitly, and so a re-require into the same state finds it.
__DCS_STUDIO_MISSION_TEARDOWN = teardown

-- Primary trigger: the mission's own end-of-life event, which fires while the
-- state is fully functional. pcall'd and feature-checked because `world` is
-- absent from a bare Lua state (the headless surface tests use one) and the
-- bridge must still load there.
if type(world) == "table" and type(world.addEventHandler) == "function" then
  local handler_ok, handler_err = pcall(world.addEventHandler, {
    onEvent = function(_, event)
      local ended = world.event and world.event.S_EVENT_MISSION_END
      if event and ended and event.id == ended then
        teardown("mission end")
      end
    end,
  })
  if not handler_ok then
    report_error("mission bridge could not register its teardown handler: " .. tostring(handler_err))
  end
end

-- Backstop: a sentinel userdata collected by lua_close, for a state that dies
-- without S_EVENT_MISSION_END ever firing. It cannot drop the router's Lua
-- handles — by then, touching Lua is the thing to avoid — so it only fails the
-- stranded requests. Parked in a global to keep it reachable for the whole life
-- of the state.
__DCS_STUDIO_MISSION_GUARD = bridge.jsonrpc.state_guard()

-- While a debug session holds the sim thread, the engine drains this DLL's
-- queue itself through this router.
if DBG then
  DBG.pump = function()
    if torn_down then
      return
    end
    bridge.jsonrpc.process_queue(router)
  end
end

-- Queue pump on model time (the DCS-gRPC pattern): does not fire while the
-- sim is paused or between missions — requests queue until the 30s server
-- timeout then. A debug_run processed inside this drain blocks the callback
-- for the whole session; the engine serves the editor itself meanwhile (the
-- queue is swap-drained, so the re-entrant pump is safe).
timer.scheduleFunction(function()
  -- Returning nil unschedules: once the state has been released there is
  -- nothing to dispatch through, and re-entering a state DCS is unloading is
  -- the whole bug this teardown removes.
  if torn_down then
    return nil
  end
  local ok, err = pcall(function()
    bridge.jsonrpc.process_queue(router)
  end)
  if not ok then
    report_error("mission pump error: " .. tostring(err))
  end
  return timer.getTime() + 0.1
end, nil, timer.getTime() + 0.1)

if started then
  report_info("mission bridge serving JSON-RPC on 127.0.0.1:25570")
else
  report_info("mission bridge reattached to the running server on 127.0.0.1:25570")
end
