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
  local DRAIN_INTERVAL_SECONDS = 0.05 -- max sim stall between RPC drains during a run
  local MAX_TABLE_CHILDREN = 1000 -- cap children returned/previewed for one table
  local MAX_REFS = 100000 -- per-pause ref ceiling so a cyclic/huge tree can't pin unbounded memory

  -- Refs above this are inspection refs (the persistent object-explorer
  -- registry); below it are per-pause snapshot refs. debug_expand routes by it.
  local INSPECT_BASE = 2000000000

  -- Two handle registries, both mapping ref → captured value/scope and inspected
  -- lazily via debug_expand. `vars` is the PER-PAUSE registry (snapshot fills it,
  -- cleared on resume). `inspect` is the PERSISTENT object-explorer registry
  -- (debug_inspect fills it; survives across calls until debug_inspect_clear).
  local dbg = { vars = {}, n = 0, inspect = {}, inspect_n = 0 }

  local function dbg_register(descriptor)
    -- Ceiling: a cyclic/huge table tree (e.g. expanding _G._G…) must not mint
    -- refs unboundedly. Past the cap, return 0 → the value renders as a leaf.
    if dbg.n >= MAX_REFS then return 0 end
    dbg.n = dbg.n + 1
    dbg.vars[dbg.n] = descriptor
    return dbg.n
  end

  -- Register into the persistent inspection registry, returning an offset ref.
  local function dbg_register_inspect(descriptor)
    if dbg.inspect_n >= MAX_REFS then return 0 end
    dbg.inspect_n = dbg.inspect_n + 1
    dbg.inspect[dbg.inspect_n] = descriptor
    return INSPECT_BASE + dbg.inspect_n
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
        if count > MAX_TABLE_CHILDREN then
          return "table (" .. MAX_TABLE_CHILDREN .. "+)"
        end
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

  -- One variables-tree entry; `ref` 0 means a leaf (not expandable). `register`
  -- selects the registry (per-pause or persistent inspection) so a child table's
  -- ref lands in the same one as its parent.
  local function dbg_var(name, value, register)
    local ref = 0
    if dbg_expandable(value) then
      ref = register({ kind = "value", value = value })
    end
    return { name = name, type = type(value), value = dbg_preview(value), ref = ref }
  end

  -- Collect a frame's named locals at `level` into the ordered list (for the
  -- variables scope) plus a name→value map and a name→true PRESENCE set. The
  -- presence set is what lets a local holding `nil`/`false` be distinguished
  -- from an absent name, so it shadows a same-named global correctly. Skips the
  -- `(*temporary)` slots. One definition for the snapshot and the condition check.
  local function collect_locals(level)
    -- `level` is the target frame as seen from collect_locals's CALLER; add 1
    -- because debug.getlocal here runs one frame deeper (inside this function).
    level = level + 1
    local list, map, present = {}, {}, {}
    local i = 1
    while true do
      local n, v = debug.getlocal(level, i)
      if not n then break end
      if string.sub(n, 1, 1) ~= "(" then
        table.insert(list, { name = n, value = v })
        map[n] = v
        present[n] = true
      end
      i = i + 1
    end
    return list, map, present
  end

  -- Collect a function's upvalues (where the host provides debug.getupvalue —
  -- DCS's hooks env strips it) into list + map + presence set, like collect_locals.
  local function collect_upvalues(func)
    local list, map, present = {}, {}, {}
    if debug.getupvalue and func then
      local j = 1
      while true do
        local n, v = debug.getupvalue(func, j)
        if not n then break end
        table.insert(list, { name = n, value = v })
        map[n] = v
        present[n] = true
        j = j + 1
      end
    end
    return list, map, present
  end

  -- Evaluate `expr` (an expression, else a statement) against an environment
  -- that resolves names through the frame's captured locals → upvalues → _G,
  -- using setfenv (present in DCS's hooks env). `env` is { locals, locals_present,
  -- upvals, upvals_present } from collect_locals/collect_upvalues. Returns
  -- (ok, value-or-error) — the real loadstring/runtime error, never a generic one.
  local function eval_expr(env, expr)
    local f, err = loadstring("return " .. expr)
    if not f then
      f, err = loadstring(expr)
    end
    if not f then
      return false, err or "compile error"
    end
    local proxy = setmetatable({}, {
      __index = function(_, k)
        if env.locals_present and env.locals_present[k] then return env.locals[k] end
        if env.upvals_present and env.upvals_present[k] then return env.upvals[k] end
        return _G[k]
      end,
    })
    setfenv(f, proxy)
    return pcall(f)
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
    -- Logical call depth, maintained by the hook's call/return events rather
    -- than walking the stack each line. Robust where frame-counting isn't: it
    -- tracks through C frames (pcall) and tail calls, and is O(1) per line.
    local depth = 0

    -- Snapshot the full Lua call stack from `base` upward (stopping at the
    -- enclosing C frame — the pcall that ran the chunk), capturing each frame's
    -- locals + upvalues as scopes. Values are captured NOW (the stack is only
    -- valid here); tables expand lazily later via their refs.
    local function snapshot(base)
      dbg.vars = {}
      dbg.n = 0
      dbg.envs = {} -- per-frame eval env (locals/upvals + presence) for debug_eval
      local frames = {}
      local level = base
      while true do
        local info = debug.getinfo(level, "nSlf")
        if not info then break end
        if info.what == "C" then break end -- the pcall boundary: stop
        local idx = #frames -- 0-based; the env and the frame share this one key
        local locals, locals_map, locals_present = collect_locals(level)
        local scopes = {
          { name = "Locals", ref = dbg_register({ kind = "scope", items = locals }) },
        }
        local upvals, upvals_map, upvals_present = collect_upvalues(info.func)
        -- The Upvalues scope only appears where the host provides getupvalue
        -- (DCS's hooks env strips it) — i.e. when collect_upvalues found any.
        if #upvals > 0 then
          table.insert(scopes, { name = "Upvalues", ref = dbg_register({ kind = "scope", items = upvals }) })
        end
        dbg.envs[idx] = {
          locals = locals_map,
          locals_present = locals_present,
          upvals = upvals_map,
          upvals_present = upvals_present,
        }
        if idx == 0 then -- globals once, on the top frame; expanded lazily
          table.insert(scopes, { name = "Globals", ref = dbg_register({ kind = "value", value = _G }) })
        end
        local name = info.name
        if not name then
          name = (info.what == "main") and "main chunk" or "?"
        end
        frames[idx + 1] = {
          index = idx,
          source = info.source,
          line = info.currentline,
          name = name,
          scopes = scopes,
        }
        level = level + 1
      end
      -- pause_id: a monotonic stop counter so the editor refreshes variables on
      -- EVERY distinct stop (incl. re-pausing on the same line in a loop), not
      -- only when the line moves. cond_error: a conditional-breakpoint error,
      -- surfaced rather than silently swallowed.
      return bridge.json.safe_encode({ frames = frames, pause_id = dbg.pause_id, cond_error = dbg.cond_error })
    end

    local hook = function(event, line)
      -- Maintain the call-depth counter off call/return events (a tail call is
      -- a "call" then a "tail return"; both keep the counter balanced).
      if event == "call" then
        depth = depth + 1
        return
      elseif event == "return" or event == "tail return" then
        depth = depth - 1
        return
      end
      -- event == "line" from here on.
      local info = debug.getinfo(2, "nSlf")
      local src = (info and info.source) or source
      -- Throttled RPC drain DURING the run, so a manual Pause/Stop (and live
      -- state queries) are delivered even while the chunk holds the sim thread.
      -- The hook is disabled while it runs, so this re-entrant drain is safe.
      local now = os.clock()
      if (now - last_drain) > DRAIN_INTERVAL_SECONDS then
        last_drain = now
        server:process_rpc(router)
      end
      -- Cooperative Stop: unwind the chunk so a runaway/looping run can be
      -- killed (there is no terminate primitive over the bridge otherwise).
      if bridge.debug.take_stop() then
        debug.sethook()
        error("debug: stopped by user", 0)
      end
      local hit = false
      if bridge.debug.should_pause(src, line) then
        local cond = bridge.debug.condition_at(src, line)
        if cond and cond ~= "" then
          -- Evaluate the condition in the stopped frame. From the hook, the
          -- debugged frame is level 2 (getinfo(2) above); collect_locals takes
          -- that caller-relative level. Resolve its locals AND upvalues.
          local _, lmap, lpresent = collect_locals(2)
          local _, umap, upresent = collect_upvalues(info and info.func)
          local ok, val = eval_expr({
            locals = lmap,
            locals_present = lpresent,
            upvals = umap,
            upvals_present = upresent,
          }, cond)
          if not ok then
            -- A broken condition fails OPEN: pause and surface the error, rather
            -- than silently never stopping (which reads as "code path not hit").
            dbg.cond_error = "breakpoint condition error: " .. tostring(val)
            hit = true
          else
            dbg.cond_error = nil
            hit = val and true or false
          end
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
        dbg.pause_id = (dbg.pause_id or 0) + 1 -- distinct-stop id (drives editor refresh)
        -- snapshot from level 3: the chunk frame is snapshot(1) <- hook(2) <- chunk(3).
        bridge.debug.set_paused(snapshot(3))
        local mode = nil
        dbg.last_ping = os.clock() -- the editor just requested this stop; it's alive
        repeat
          server:process_rpc(router) -- a debug_state during this drain refreshes last_ping
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
    dbg.cond_error = nil
    dbg.pause_id = 0
    -- Clear any stale break-all / resume / pause from a prior session so it
    -- can't phantom-break this run on its first line.
    bridge.debug.reset_session()
    dbg.last_ping = os.clock()
    debug.sethook(hook, "clr") -- call + line + return events (depth + lines)
    local ran_ok, run_err = pcall(chunk)
    debug.sethook() -- always remove the scoped hook
    dbg.running = false
    if not ran_ok then
      local msg = tostring(run_err)
      -- A user Stop unwinds via error() but is a clean end, not a failure.
      if not string.find(msg, "debug: stopped", 1, true) then
        dbg.error = msg
      end
      return { ran = false, error = dbg.error }
    end
    return { ran = true }
  end)

  -- Lazily expand a variable/scope ref: a scope yields its variables; a table
  -- value yields its children (each with its own ref if itself expandable). The
  -- ref routes by range to the per-pause registry or the persistent inspection
  -- registry, and children land in the same one as their parent.
  router:add_method("debug_expand", function(params)
    local ref = params.ref or 0
    local registry, register
    if ref >= INSPECT_BASE then
      registry, register = dbg.inspect, dbg_register_inspect
      ref = ref - INSPECT_BASE
    else
      registry, register = dbg.vars, dbg_register
    end
    local d = registry[ref]
    if not d then
      return { variables = {} }
    end
    local out = {}
    if d.kind == "scope" then
      for _, item in ipairs(d.items) do
        table.insert(out, dbg_var(item.name, item.value, register))
      end
    elseif d.kind == "value" and type(d.value) == "table" then
      local count = 0
      for k, v in pairs(d.value) do
        table.insert(out, dbg_var(tostring(k), v, register))
        count = count + 1
        if count >= MAX_TABLE_CHILDREN then
          table.insert(out, { name = "…", type = "string", value = "(truncated)", ref = 0 })
          break
        end
      end
    end
    return { variables = out }
  end)

  -- Evaluate `expr` against the live global (hooks) environment and register the
  -- result for lazy exploration — the interactive object explorer, no pause or
  -- breakpoint needed. The ref survives across calls until debug_inspect_clear.
  router:add_method("debug_inspect", function(params)
    local expr = params.expr or ""
    local f, err = loadstring("return " .. expr)
    if not f then
      f, err = loadstring(expr)
    end
    if not f then
      return { ok = false, err = err or "compile error" }
    end
    local ok, res = pcall(f)
    if not ok then
      return { ok = false, err = tostring(res) }
    end
    local ref = 0
    if dbg_expandable(res) then
      ref = dbg_register_inspect({ kind = "value", value = res })
    end
    return { ok = true, type = type(res), value = dbg_preview(res), ref = ref }
  end)

  -- Drop every inspection ref, releasing the held values.
  router:add_method("debug_inspect_clear", function()
    dbg.inspect = {}
    dbg.inspect_n = 0
    return { ok = true }
  end)

  -- Evaluate an expression in a paused frame's environment (watches + the debug
  -- console). Resolves names through that frame's locals/upvalues then globals.
  router:add_method("debug_eval", function(params)
    local frame = params.frame or 0
    local env = dbg.envs[frame] or dbg.envs[0]
    if not env then
      return { ok = false, err = "no active frame" }
    end
    local ok, res = eval_expr(env, params.expr or "")
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

  -- Stop: terminate the running chunk. Request the unwind, and release the pump
  -- with a continue so a paused session resumes straight into the stop check.
  router:add_method("debug_stop", function()
    bridge.debug.request_stop()
    bridge.debug.request_resume("continue")
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
