-- DCS Studio GameGUI hook.
-- Loads the dcs_studio native module and serves JSON-RPC over WebSocket on
-- ws://127.0.0.1:25569/ws. The request queue is drained once per simulation
-- frame; onSimulationFrame fires at the main menu too (verified live), so
-- RPCs answer from boot — DCS.getModelTime() stays 0 until a mission runs.
--
-- Installed to <writedir>\Scripts\Hooks\DcsStudio.lua by deploy.ps1; the DLL
-- lives at <writedir>\Mods\tech\DcsStudio\bin\dcs_studio.dll.

package.cpath = package.cpath .. ";" .. lfs.writedir() .. "Mods\\tech\\DcsStudio\\bin\\?.dll"

-- Read by the module on require() for configuration.
DCS_STUDIO = { logger_level = "info" }

local ok, bridge = pcall(require, "dcs_studio")
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

  -- Debugger (model/dcs/debug.pds). Run a chunk under a line hook SCOPED to
  -- that chunk's pcall — never a global hook over DCS's own GUI. On a line
  -- carrying a breakpoint (or the next qualifying line of a pending step) it
  -- snapshots the full call stack, then PUMPS the RPC queue itself so the
  -- editor can inspect / resume / step while the world is frozen. The pause is
  -- held as long as the editor keeps polling (debug_state refreshes a liveness
  -- timestamp); only after DEBUG_IDLE_SECONDS with NO client activity — a
  -- vanished editor — does it auto-continue, so a held breakpoint never freezes
  -- the sim forever. In Lua 5.1 the hook is disabled while it runs, so the
  -- pump's own lines never re-trigger it.
  local DEBUG_IDLE_SECONDS = 30 -- auto-continue after this long with no client polling

  -- Variable handle registry, kept alive across RPC calls FOR THE DURATION OF A
  -- PAUSE so the editor can expand tables lazily (debug_expand). Each ref maps
  -- to a captured value or a captured scope; cleared on resume so nothing is
  -- pinned. `debug_run`'s snapshot and the `debug_expand` method share it.
  local dbg = { vars = {}, n = 0 }

  local function dbg_register(descriptor)
    dbg.n = dbg.n + 1
    dbg.vars[dbg.n] = descriptor
    return dbg.n
  end

  -- A short, single-line preview of a value for the variables tree.
  local function dbg_preview(v)
    local t = type(v)
    if t == "string" then
      local s = string.gsub(v, "[\r\n]", " ")
      if #s > 60 then
        s = string.sub(s, 1, 57) .. "..."
      end
      return '"' .. s .. '"'
    elseif t == "table" then
      local count = 0
      for _ in pairs(v) do
        count = count + 1
      end
      return "table (" .. count .. ")"
    elseif t == "function" or t == "userdata" or t == "thread" then
      return t
    else
      return tostring(v)
    end
  end

  -- Only tables expand (userdata/function expansion is unreliable in 5.1).
  local function dbg_expandable(v)
    return type(v) == "table"
  end

  -- One variables-tree entry; `ref` 0 means a leaf (not expandable).
  local function dbg_var(name, value)
    local ref = 0
    if dbg_expandable(value) then
      ref = dbg_register({ kind = "value", value = value })
    end
    return { name = name, type = type(value), value = dbg_preview(value), ref = ref }
  end

  -- Evaluate `expr` (an expression, else a statement) against an environment
  -- that resolves names through the frame's captured locals → upvalues → _G,
  -- using setfenv (present in DCS's hooks env). Returns (ok, value-or-error).
  local function eval_expr(locals, upvals, expr)
    local f = loadstring("return " .. expr)
    if not f then
      f = loadstring(expr)
    end
    if not f then
      return false, "compile error"
    end
    local proxy = setmetatable({}, {
      __index = function(_, k)
        if locals then
          local v = locals[k]
          if v ~= nil then return v end
        end
        if upvals then
          local v = upvals[k]
          if v ~= nil then return v end
        end
        return _G[k]
      end,
    })
    setfenv(f, proxy)
    return pcall(f)
  end

  -- The current frame's locals as a name→value map (innermost wins), captured
  -- live at `level` for the conditional-breakpoint check at the hook.
  local function live_locals(level)
    local m = {}
    local i = 1
    while true do
      local n, v = debug.getlocal(level, i)
      if not n then break end
      if string.sub(n, 1, 1) ~= "(" then
        m[n] = v
      end
      i = i + 1
    end
    return m
  end

  router:add_method("debug_run", function(params)
    -- A "=name" chunkname makes debug.getinfo(...).source read back verbatim,
    -- so breakpoints set under the same source string line up.
    local source = params.source or "=debug"
    local chunk, lerr = loadstring(params.code, source)
    if not chunk then
      error("loadstring: " .. tostring(lerr))
    end

    local step_mode = nil -- "over" | "into" | "out" pending, or nil
    local step_depth = 0
    local last_drain = os.clock()

    -- Active frame count from the function that triggered the hook upward; only
    -- relative values matter (step over/out compare against the paused depth).
    local function cur_depth()
      local d = 2
      while debug.getinfo(d, "l") do
        d = d + 1
      end
      return d - 2
    end

    -- Snapshot the full Lua call stack from `base` upward (stopping at the
    -- enclosing C frame — the pcall that ran the chunk), capturing each frame's
    -- locals + upvalues as scopes. Values are captured NOW (the stack is only
    -- valid here); tables expand lazily later via their refs.
    local function snapshot(base)
      dbg.vars = {}
      dbg.n = 0
      dbg.envs = {} -- per-frame { locals = map, upvals = map } for evaluate-in-frame
      local frames = {}
      local level = base
      while true do
        local info = debug.getinfo(level, "nSlf")
        if not info then break end
        if info.what == "C" then break end -- the pcall boundary: stop
        local locals = {}
        local locals_map = {}
        local i = 1
        while true do
          local n, v = debug.getlocal(level, i)
          if not n then break end
          if string.sub(n, 1, 1) ~= "(" then -- skip (*temporary) slots
            table.insert(locals, { name = n, value = v })
            locals_map[n] = v
          end
          i = i + 1
        end
        local scopes = {
          { name = "Locals", ref = dbg_register({ kind = "scope", items = locals }) },
        }
        local upvals_map = {}
        -- DCS's hooks environment strips debug.getupvalue, so the Upvalues
        -- scope only appears where the host actually provides it.
        if debug.getupvalue and info.func then
          local upvals = {}
          local j = 1
          while true do
            local n, v = debug.getupvalue(info.func, j)
            if not n then break end
            table.insert(upvals, { name = n, value = v })
            upvals_map[n] = v
            j = j + 1
          end
          table.insert(scopes, { name = "Upvalues", ref = dbg_register({ kind = "scope", items = upvals }) })
        end
        dbg.envs[#frames] = { locals = locals_map, upvals = upvals_map }
        if #frames == 0 then -- globals once, on the top frame; expanded lazily
          table.insert(scopes, { name = "Globals", ref = dbg_register({ kind = "value", value = _G }) })
        end
        local name = info.name
        if not name then
          name = (info.what == "main") and "main chunk" or "?"
        end
        table.insert(frames, {
          index = #frames,
          source = info.source,
          line = info.currentline,
          name = name,
          scopes = scopes,
        })
        level = level + 1
      end
      return bridge.json.safe_encode({ frames = frames })
    end

    local hook = function(_, line)
      local info = debug.getinfo(2, "S")
      local src = (info and info.source) or source
      local depth = cur_depth()
      -- Throttled RPC drain DURING the run, so a manual Pause (and live state
      -- queries) are delivered even while the chunk holds the sim thread. The
      -- hook is disabled while it runs, so this re-entrant drain is safe.
      local now = os.clock()
      if (now - last_drain) > 0.05 then
        last_drain = now
        server:process_rpc(router)
      end
      local hit = false
      if bridge.debug.should_pause(src, line) then
        -- A conditional breakpoint pauses only when its expression is truthy in
        -- the stopped frame (level 3: live_locals(1) <- hook(2) <- debugged(3)).
        local cond = bridge.debug.condition_at(src, line)
        if cond and cond ~= "" then
          local ok, val = eval_expr(live_locals(3), nil, cond)
          hit = (ok and val) and true or false
        else
          hit = true
        end
      end
      -- Manual Pause / break-all: stop at the next line.
      if not hit and bridge.debug.take_pause() then
        hit = true
      end
      if not hit then
        if step_mode == "into" then
          hit = true
        elseif step_mode == "over" then
          hit = depth <= step_depth
        elseif step_mode == "out" then
          hit = depth < step_depth
        end
      end
      if hit then
        step_mode = nil
        -- snapshot from level 3: the chunk frame is snapshot(1) <- hook(2) <- chunk(3).
        bridge.debug.set_paused(snapshot(3))
        local mode = nil
        dbg.last_ping = os.clock() -- the editor just requested this stop; it's alive
        repeat
          server:process_rpc(router) -- keep answering RPC while paused (bumps last_ping)
          mode = bridge.debug.take_resume()
          if not mode and (os.clock() - dbg.last_ping) > DEBUG_IDLE_SECONDS then
            mode = "continue" -- the editor stopped polling (gone): don't freeze forever
          end
        until mode ~= nil
        bridge.debug.clear_paused()
        dbg.vars = {} -- release captured values; refs are per-pause
        dbg.n = 0
        if mode == "step_over" then
          step_mode = "over"
          step_depth = depth
        elseif mode == "step_into" then
          step_mode = "into"
          step_depth = depth
        elseif mode == "step_out" then
          step_mode = "out"
          step_depth = depth
        else
          step_mode = nil -- continue: only breakpoints pause again
        end
      end
    end

    -- Session liveness is reported via debug_state (running / error), so the
    -- editor detects the end by polling rather than by awaiting this call —
    -- which it can't, since debug_run blocks for the whole session and the
    -- client's per-call timeout would otherwise fire on a long run or pause.
    dbg.running = true
    dbg.error = nil
    dbg.last_ping = os.clock()
    debug.sethook(hook, "l")
    local ran_ok, run_err = pcall(chunk)
    debug.sethook() -- always remove the scoped hook
    dbg.running = false
    if not ran_ok then
      dbg.error = tostring(run_err)
      return { ran = false, error = dbg.error }
    end
    return { ran = true }
  end)

  -- Lazily expand a variable/scope ref captured at the current pause: a scope
  -- yields its variables; a table value yields its children (each with its own
  -- ref if itself expandable). Only valid while paused.
  router:add_method("debug_expand", function(params)
    local d = dbg.vars[params.ref]
    if not d then
      return { variables = {} }
    end
    local out = {}
    if d.kind == "scope" then
      for _, item in ipairs(d.items) do
        table.insert(out, dbg_var(item.name, item.value))
      end
    elseif d.kind == "value" and type(d.value) == "table" then
      local count = 0
      for k, v in pairs(d.value) do
        table.insert(out, dbg_var(tostring(k), v))
        count = count + 1
        if count >= 1000 then
          table.insert(out, { name = "…", type = "string", value = "(truncated)", ref = 0 })
          break
        end
      end
    end
    return { variables = out }
  end)

  -- Evaluate an expression in a paused frame's environment (watches + the debug
  -- console). Resolves names through that frame's locals/upvalues then globals.
  router:add_method("debug_eval", function(params)
    local frame = params.frame or 0
    local env = dbg.envs[frame] or dbg.envs[0]
    if not env then
      return { ok = false, err = "no active frame" }
    end
    local ok, res = eval_expr(env.locals, env.upvals, params.expr or "")
    if not ok then
      return { ok = false, err = tostring(res) }
    end
    local ref = 0
    if dbg_expandable(res) then
      ref = dbg_register({ kind = "value", value = res })
    end
    return { ok = true, type = type(res), value = dbg_preview(res), ref = ref }
  end)

  router:add_method("debug_continue", function(params)
    local mode = (params and params.mode) or "continue"
    bridge.debug.request_resume(mode)
    return { ok = true, mode = mode }
  end)

  -- Manual Pause / break-all: stop at the next line of debugged code. Delivered
  -- to the busy sim thread via the hook's throttled drain.
  router:add_method("debug_pause", function()
    bridge.debug.request_pause()
    return { ok = true }
  end)

  router:add_method("debug_state", function()
    dbg.last_ping = os.clock() -- the editor is alive; keep any held pause alive
    local snap = bridge.debug.paused()
    if snap == nil then
      return { paused = false, running = dbg.running or false, error = dbg.error }
    end
    return { paused = true, running = true, snapshot = snap }
  end)

  local cb = {}
  function cb.onSimulationFrame()
    server:process_rpc(router) -- drains queued WS requests (fires at the menu too)
  end
  DCS.setUserCallbacks(cb)

  log.write("DCS-STUDIO", log.INFO, "dcs_studio serving JSON-RPC on 127.0.0.1:25569")
end)
if not started then
  log.write("DCS-STUDIO", log.ERROR, "startup failed: " .. tostring(err))
end
