-- DCS Studio GameGUI hook.
-- Loads the dcs_bridge native module and serves JSON-RPC over WebSocket on
-- ws://127.0.0.1:25569/ws. The request queue is drained once per simulation
-- frame; onSimulationFrame fires at the main menu too (verified live), so
-- RPCs answer from boot — DCS.getModelTime() stays 0 until a mission runs.
--
-- Installed to <writedir>\Scripts\Hooks\DcsStudio.lua by deploy.ps1; the DLL
-- lives at <writedir>\Mods\tech\DcsStudio\bin\dcs_bridge.dll.

package.cpath = package.cpath .. ";" .. lfs.writedir() .. "Mods\\tech\\DcsStudio\\bin\\?.dll"

-- Read by the module on require() for configuration.
DCS_BRIDGE = { logger_level = "info" }

local ok, bridge = pcall(require, "dcs_bridge")
if not ok then
  log.write("DCS-STUDIO", log.ERROR, "load failed: " .. tostring(bridge))
  return
end

local started, err = pcall(function()
  -- Short server-side timeout (vs the 300s default) so a stalled editor
  -- request can never wedge the WS read loop for minutes.
  local server = bridge.jsonrpc.JsonRpcServer.new({ host = "127.0.0.1", port = 25569, timeout = 5 })
  local router = bridge.jsonrpc.JsonRpcRouter.new()

  router:add_method("ping", function(params)
    return { pong = true, dcs_time = (DCS.getModelTime and DCS.getModelTime()) or 0 }
  end)

  -- Run arbitrary Lua in the GUI/hooks environment and return the result.
  -- localhost-only by the server bind; gives full DCS.*/net.* control
  -- (e.g. start missions, DCS.exitProcess()) for the editor and dev tooling.
  router:add_method("eval", function(params)
    local f, err = loadstring(params.code)
    if not f then
      error("loadstring: " .. tostring(err))
    end
    return f()
  end)

  local cb = {}
  function cb.onSimulationFrame()
    server:process_rpc(router) -- drains queued WS requests (fires at the menu too)
  end
  DCS.setUserCallbacks(cb)

  log.write("DCS-STUDIO", log.INFO, "dcs_bridge serving JSON-RPC on 127.0.0.1:25569")
end)
if not started then
  log.write("DCS-STUDIO", log.ERROR, "startup failed: " .. tostring(err))
end
