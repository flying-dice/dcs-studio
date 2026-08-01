-- DCS Studio mission bridge init. Embedded in dcs_studio_mission.dll and run
-- by luaopen on EVERY mission load (fresh mission Lua state each time; the
-- DLL image and its statics persist for the process lifetime). Receives the
-- bridge exports table as the chunk argument.
--
-- Binds a JSON-RPC server on 127.0.0.1:25570 that THIS state owns, registers the
-- mission-state method set, and schedules the queue pump on model time — the
-- DCS-gRPC pattern. While a debug_run holds the sim thread, the debug engine
-- serves the editor itself (DBG.pump → server:process_rpc), so the scheduled pump
-- being blocked is fine.
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

-- Bind this mission's own server. `serve` hands back userdata that OWNS it: the
-- listener, its actix worker and its request queue all live exactly as long as
-- THIS Lua state holds the value, and stop when it does not. Nothing is shared
-- through the DLL between missions, so each mission gets a fresh worker and
-- fresh connections (card 18, iteration 3 — the owner's Lua-lifecycle directive).
--
-- It is deliberately NOT parked in a global. The pump closures below capture it,
-- and DCS's timer holds those for the life of the state, which is precisely the
-- lifetime wanted — while a global would hand any co-installed mod or mission
-- script a `:stop()` that ends the bridge for the rest of the mission (the same
-- reasoning that removed __DCS_STUDIO_MISSION_TEARDOWN).
local server_ok, server = pcall(bridge.jsonrpc.serve, {
  host = "127.0.0.1",
  port = 25570,
  timeout = 30,
  env = "mission",
})
if not server_ok or not server then
  report_error("mission bridge server failed to start: " .. tostring(server))
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
--
-- The release ALSO stops this mission's HTTP server (card 18, second iteration,
-- live-verified 2/2 clean): releasing the handlers alone was necessary and
-- insufficient — DCS still died whenever the mission bridge's actix worker had
-- accepted connections during the mission, including in a run that was paused
-- throughout so nothing was ever dispatched into Lua. So the worker and its
-- connections must not span the unload either.
--
-- The step ORDER inside bridge's teardown is load-bearing and verified: handlers,
-- then the queue's -32001s (read off the still-running server), then the
-- listener. Do not re-arrange it.
--
-- If this trigger never fires — a mission that ends without S_EVENT_MISSION_END —
-- the server userdata's own __gc during lua_close now stops it anyway. That is
-- iteration 3 closing iteration 2's one documented gap.
local torn_down = false

local function teardown(why)
  if torn_down then
    return
  end
  torn_down = true
  local ok, released_or_err, failed, stopped_port = pcall(server.teardown, server, router, why)
  if ok then
    -- The stopped port is reported through env.info deliberately: the shipped
    -- logger level is `warn`, so the Rust-side info line does not reach
    -- dcs_studio_mission.log, and this is the diagnostic a live unload needs.
    -- Deliberately NOT named `server`: that would shadow the userdata this
    -- closure needs, and the next edit to move it above the pcall would take the
    -- teardown with it.
    local server_note = stopped_port
        and ("stopped its HTTP server on port " .. tostring(stopped_port))
        or "had no HTTP server to stop"
    report_info(string.format("mission bridge released %s Lua handler(s), failed %s queued request(s) and %s on %s",
      tostring(released_or_err), tostring(failed), server_note, tostring(why)))
  else
    -- Never fatal: this runs on DCS's way out of the mission, and a raise here
    -- would land in the engine's event dispatcher with nothing to catch it.
    report_error("mission bridge teardown failed: " .. tostring(released_or_err))
  end
end

-- Deliberately NOT published as a global, and neither is `server` — anything in
-- this state (another mod, a mission script) could call either, and one call
-- silently ends the bridge for the rest of the mission. There is no caller that
-- needs one: the event handler below is the trigger, and the server userdata's
-- own collection by lua_close is the backstop.

-- Primary trigger: the mission's own end-of-life event, which fires while the
-- state is fully functional. pcall'd and feature-checked because `world` is
-- absent from a bare Lua state (the headless surface tests use one) and the
-- bridge must still load there.
if type(world) == "table" and type(world.addEventHandler) == "function" then
  local handler_ok, handler_err = pcall(world.addEventHandler, {
    -- Protected like the timer pump below, and for the same reason: this body
    -- is called from DCS's C++ event dispatcher for EVERY event the mission
    -- raises, and a raise escaping into it has nothing to catch it. Nothing
    -- here can raise today; the pcall is what keeps that true after an edit.
    onEvent = function(_, event)
      local ok, err = pcall(function()
        local ended = world.event and world.event.S_EVENT_MISSION_END
        if event and ended and event.id == ended then
          teardown("mission end")
        end
      end)
      if not ok then
        report_error("mission bridge teardown handler error: " .. tostring(err))
      end
    end,
  })
  if not handler_ok then
    report_error("mission bridge could not register its teardown handler: " .. tostring(handler_err))
  end
end

-- Backstop: none is wired here any more, and that is the point. The server
-- userdata IS the sentinel — lua_close collects it and its destructor stops the
-- listener, fails the stranded requests and waits (tightly bounded) for the actix
-- System thread. Iteration 2 needed a separate sentinel because the server lived
-- in a DLL static that no state's death could reach; it could only fail the queue,
-- so an event-less mission kept its listener across the unload.

-- While a debug session holds the sim thread, the engine drains this mission's
-- queue itself through this router — reaching it through the server userdata this
-- state owns, not through the DLL.
if DBG then
  DBG.pump = function()
    if torn_down then
      return
    end
    server:process_rpc(router)
  end
end

-- The pump body, hoisted out of the scheduled callback rather than built inside
-- it. pcall needs a function value, and written inline that is a fresh closure
-- allocated on every tick for the whole mission — garbage per tick, forever, for
-- a function that closes over nothing that changes. One named local costs one
-- allocation, once. (The same reasoning as the GameGUI hook's frame callback,
-- where it runs six times as often.)
local function drain_queue()
  server:process_rpc(router)
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
  local ok, err = pcall(drain_queue)
  if not ok then
    report_error("mission pump error: " .. tostring(err))
  end
  return timer.getTime() + 0.1
end, nil, timer.getTime() + 0.1)

report_info("mission bridge serving JSON-RPC on 127.0.0.1:25570")
