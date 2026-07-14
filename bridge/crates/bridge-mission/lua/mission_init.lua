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
local bridge = ...

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

local D = __DCS_STUDIO_DBG -- installed by bootstrap; nil if this state lacks the debug library
local RT = assert(__DCS_STUDIO_RT, "console runtime failed to install in the mission state")

local router = bridge.jsonrpc.JsonRpcRouter.new()

-- Register every JSON-RPC method (ping/eval/console/repl/debug/…) — the shared
-- chunk (bridge.register_methods, embedded in the DLL) closes over the injected
-- touchpoints, so the same registration runs live here and headless in the
-- OpenRPC golden test.
bridge.register_methods(router, {
  bridge = bridge,
  D = D,
  RT = RT,
})

-- While a debug session holds the sim thread, the engine drains this DLL's
-- queue itself through this router.
if D then
  D.pump = function()
    bridge.jsonrpc.process_queue(router)
  end
end

-- Queue pump on model time (the DCS-gRPC pattern): does not fire while the
-- sim is paused or between missions — requests queue until the 30s server
-- timeout then. A debug_run processed inside this drain blocks the callback
-- for the whole session; the engine serves the editor itself meanwhile (the
-- queue is swap-drained, so the re-entrant pump is safe).
timer.scheduleFunction(function()
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
