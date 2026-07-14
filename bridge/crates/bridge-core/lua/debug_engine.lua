-- DCS Studio debug engine (installed as __DCS_STUDIO_DBG). Embedded in the
-- bridge DLLs (include_str!) and installed by bootstrap() into each DLL's own
-- Lua state, with the bridge exports table passed as the chunk argument — the
-- DLL is by definition already loaded when this runs, so no require here.
-- Pure Lua 5.1 otherwise.
--
-- The engine runs a chunk under a line hook SCOPED to that chunk's xpcall —
-- never a global hook over DCS's own code. On a line carrying a breakpoint
-- (or the next qualifying line of a pending step) it snapshots the full call
-- stack, then pumps the RPC queue (D.pump, wired by the installer) so the
-- editor can inspect / resume / step while the world is frozen. The pause is
-- held as long as the editor keeps polling (debug_state refreshes a liveness
-- timestamp); only after 30s with NO client activity — a vanished editor —
-- does it auto-continue, so a held breakpoint never freezes the sim forever.
-- In Lua 5.1 the hook is disabled while it runs, so the pump's own lines
-- never re-trigger it.
--
-- Returns nil on success, or an error string the installer logs (never raises:
-- a state without the debug library still gets the rest of the bridge).

local bridge = ...

if type(debug) ~= "table" or type(debug.sethook) ~= "function"
  or type(debug.getinfo) ~= "function" or type(debug.getlocal) ~= "function" then
  return "the debug library is not available in this Lua state - breakpoints cannot work here"
end

if not (__DCS_STUDIO_DBG and __DCS_STUDIO_DBG.version == 1) then
  local DEBUG_IDLE_SECONDS = 30 -- auto-continue after this long with no client polling
  local DRAIN_INTERVAL_SECONDS = 0.05 -- max sim stall between RPC drains during a run
  local MAX_TABLE_CHILDREN = 1000 -- cap children returned/previewed for one table
  local MAX_REFS = 100000 -- per-pause ref ceiling so a cyclic/huge tree can't pin unbounded memory

  -- os.clock (CPU time) keeps ticking while a chunk holds the sim thread;
  -- timer.getTime (model time) does NOT, so under that fallback the throttled
  -- in-run drain and the idle auto-continue degrade (breakpoints still work).
  -- Captured at install time — in the mission state that is whatever survived
  -- sanitization as an upvalue here.
  local clock = (type(os) == "table" and os.clock)
    or (type(timer) == "table" and timer.getTime)
    or function() return 0 end

  local D = { version = 1, running = false, error = nil }
  D.pump = function() end -- the installer wires the env-specific RPC drain

  -- The per-pause handle registry: ref → captured value/scope, inspected lazily
  -- via expand(). Snapshot fills `vars`, resume clears it — every ref is scoped
  -- to one pause.
  local dbg = { vars = {}, n = 0 }

  local function dbg_register(descriptor)
    -- Ceiling: a cyclic/huge table tree (e.g. expanding _G._G…) must not mint
    -- refs unboundedly. Past the cap, return 0 → the value renders as a leaf.
    if dbg.n >= MAX_REFS then return 0 end
    dbg.n = dbg.n + 1
    dbg.vars[dbg.n] = descriptor
    return dbg.n
  end

  -- A short, single-line preview of a value for the variables tree. Deliberately
  -- MIRRORS (does not share) rt.lua's `preview`: the two diverge on functions —
  -- the debugger renders a bare "function" here, the REPL explorer shows arity —
  -- and the engine stays self-contained: it must not depend on __DCS_STUDIO_RT
  -- being the matching build inside a paused, possibly sanitized state. The
  -- key-order comparator in D.expand mirrors rt.lua's key_order the same way.
  -- Kept in sync by hand.
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
  -- DCS's hooks env strips it; the mission env keeps it) into list + map +
  -- presence set, like collect_locals.
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
  -- using setfenv (Lua 5.1, present in both hosted states). `env` is { locals,
  -- locals_present, upvals, upvals_present } from collect_locals/collect_upvalues.
  -- Returns (ok, value-or-error) — the real loadstring/runtime error, never a
  -- generic one.
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
      -- A bare-name write inside an evaluated statement would land in this
      -- throwaway proxy and silently vanish — the worst kind of "worked".
      -- Refuse it loudly; top-level `name = value` goes through the real
      -- assignment path in eval() instead. (`a.b = 1` still mutates the
      -- real table `a` — __index hands it out — which is intended.)
      __newindex = function(_, k)
        error(
          "assignment to '" .. tostring(k) .. "' here would be lost — use a top-level `name = value`",
          0
        )
      end,
    })
    setfenv(f, proxy)
    return pcall(f)
  end

  -- Write `value` into `name` in paused frame `frame_idx`, for real: a local
  -- via debug.setlocal on the LIVE stack, an upvalue via debug.setupvalue
  -- (where the host provides it), else a global. The live level is found by
  -- walking down to the hook's own invocation frame (everything above it is
  -- the pause pump) and re-walking the debuggee frames exactly as snapshot
  -- did. The whole walk-and-set lives in ONE function body because debug.*
  -- level numbers are relative to the caller — splitting it would skew them.
  local function assign_in_frame(frame_idx, name, value)
    local env = dbg.envs and dbg.envs[frame_idx]
    if env and env.locals_present and env.locals_present[name] then
      if not dbg.hook_fn then
        return false, "no live pause to assign into"
      end
      local l = 2
      while true do
        local i = debug.getinfo(l, "f")
        if not i then return false, "paused frame is not live (step once and retry)" end
        if i.func == dbg.hook_fn then break end
        l = l + 1
      end
      local level = l + 1
      local idx = 0
      local seen_lua = false
      while true do
        local i = debug.getinfo(level, "S")
        if not i then return false, "frame not found on the live stack" end
        if i.what == "C" then
          if seen_lua then return false, "frame not found on the live stack" end
          level = level + 1
        else
          seen_lua = true
          if idx == frame_idx then
            -- The LAST slot with this name wins: later declarations shadow.
            local target, j = nil, 1
            while true do
              local n = debug.getlocal(level, j)
              if not n then break end
              if n == name then target = j end
              j = j + 1
            end
            if not target then return false, "no local '" .. name .. "' in the live frame" end
            debug.setlocal(level, target, value)
            env.locals[name] = value -- keep the captured eval env in step
            return true
          end
          idx = idx + 1
          level = level + 1
        end
      end
    end
    if env and env.upvals_present and env.upvals_present[name] then
      local func = dbg.frame_funcs and dbg.frame_funcs[frame_idx]
      if not (debug.setupvalue and func) then
        return false, "upvalue assignment is not supported in this host"
      end
      local j = 1
      while true do
        local n = debug.getupvalue(func, j)
        if not n then break end
        if n == name then
          debug.setupvalue(func, j, value)
          env.upvals[name] = value
          return true
        end
        j = j + 1
      end
      return false, "no upvalue '" .. name .. "'"
    end
    _G[name] = value
    return true
  end

  -- The editor's poll: paused/running/error + the pause snapshot. SIDE EFFECT:
  -- although it reads as a getter, it WRITES dbg.last_ping = clock() on every
  -- call — this is the liveness heartbeat that keeps a held pause alive (hold_pause
  -- auto-continues DEBUG_IDLE_SECONDS after the last poll). Its name is the RPC
  -- surface `debug_state`, so it stays `state`; the write is intentional.
  function D.state()
    dbg.last_ping = clock()
    local snap = bridge.debug.paused()
    if snap == nil then
      return { paused = false, running = D.running or false, error = D.error }
    end
    return { paused = true, running = true, snapshot = snap }
  end

  -- Lazily expand a variable/scope ref from the per-pause registry: a scope
  -- yields its variables; a table value yields its children (each with its own
  -- ref if itself expandable), which land in the same registry as their parent.
  function D.expand(ref)
    ref = ref or 0
    local d = dbg.vars[ref]
    if not d then
      return { variables = {} }
    end
    local out = {}
    if d.kind == "scope" then
      for _, item in ipairs(d.items) do
        table.insert(out, dbg_var(item.name, item.value, dbg_register))
      end
    elseif d.kind == "value" and type(d.value) == "table" then
      -- Collect up to the cap, then SORT for a stable, readable order (pairs()
      -- is hash order): numeric keys ascending first (so arrays stay 1,2,3),
      -- then string keys alphabetically. This comparator MIRRORS rt.lua's
      -- key_order inline (see the dbg_preview lockstep note); kept in sync by
      -- hand so the engine stays self-contained.
      local keys, truncated = {}, false
      for k in pairs(d.value) do
        if #keys >= MAX_TABLE_CHILDREN then
          truncated = true
          break
        end
        table.insert(keys, k)
      end
      table.sort(keys, function(a, b)
        local na, nb = type(a) == "number", type(b) == "number"
        if na ~= nb then return na end -- numbers before strings
        if na then return a < b end
        -- Case-insensitive alphabetical, with the raw key as a stable tiebreak.
        local la, lb = string.lower(tostring(a)), string.lower(tostring(b))
        if la ~= lb then return la < lb end
        return tostring(a) < tostring(b)
      end)
      for _, k in ipairs(keys) do
        table.insert(out, dbg_var(tostring(k), d.value[k], dbg_register))
      end
      if truncated then
        table.insert(out, { name = "…", type = "string", value = "(truncated)", ref = 0 })
      end
    end
    return { variables = out }
  end

  -- Evaluate an expression in a paused frame's environment (watches + the debug
  -- console). Resolves names through that frame's locals/upvalues then globals.
  -- A top-level `name = value` ASSIGNS for real (locals via setlocal on the
  -- live stack, upvalues via setupvalue, else the global) — `assigned = true`
  -- tells the editor to refresh its variable view.
  function D.eval(frame, expr)
    frame = frame or 0
    local env = dbg.envs and (dbg.envs[frame] or dbg.envs[0])
    if not env then
      return { ok = false, err = "no active frame" }
    end
    expr = expr or ""
    local name, rhs = string.match(expr, "^%s*([%a_][%w_]*)%s*=%s*(.+)$")
    if name and string.sub(rhs, 1, 1) ~= "=" then -- `x == y` is a comparison, not an assignment
      local okv, val = eval_expr(env, rhs)
      if not okv then
        return { ok = false, err = tostring(val) }
      end
      local oka, aerr = assign_in_frame(frame, name, val)
      if not oka then
        return { ok = false, err = tostring(aerr) }
      end
      local ref = 0
      if dbg_expandable(val) then
        ref = dbg_register({ kind = "value", value = val })
      end
      return { ok = true, assigned = true, type = type(val), value = dbg_preview(val), ref = ref }
    end
    local ok, res = eval_expr(env, expr)
    if not ok then
      return { ok = false, err = tostring(res) }
    end
    local ref = 0
    if dbg_expandable(res) then
      ref = dbg_register({ kind = "value", value = res })
    end
    return { ok = true, type = type(res), value = dbg_preview(res), ref = ref }
  end

  -- Replace the breakpoints for one source: { source, breakpoints = { { line,
  -- condition? }, ... } }. The registry and the per-line conditions live in
  -- THIS DLL's statics — breakpoints must be sent to the bridge whose state
  -- runs the code.
  function D.set_breakpoints(params)
    local source = (params and params.source) or ""
    local bps = (params and params.breakpoints) or {}
    local lines = {}
    for i = 1, #bps do
      lines[#lines + 1] = bps[i].line
    end
    local count = bridge.debug.set_breakpoints(source, lines)
    for i = 1, #bps do
      -- A nil/absent condition CLEARS any stale one left on this line.
      bridge.debug.set_condition(source, bps[i].line, bps[i].condition)
    end
    return { count = count }
  end

  -- Drop every breakpoint and condition (session start/end hygiene).
  function D.clear_breakpoints()
    bridge.debug.clear_breakpoints()
    return { ok = true }
  end

  -- Run `code` (chunkname `source`, "=name" so debug.getinfo(...).source reads
  -- back verbatim and breakpoints registered under the same string line up)
  -- under the scoped line hook. Blocks for the whole session, pumping the RPC
  -- queue during pauses (and, throttled, during the run). Returns
  -- { ran = true } or { ran = false, error? } — a user Stop ends the run
  -- cleanly with no error.
  function D.run(code, source, pause_on_error)
    source = source or "=debug"
    if D.running or bridge.debug.paused() ~= nil then
      return { ran = false, error = "a debug session is already running" }
    end
    local chunk, lerr = loadstring(code or "", source)
    if not chunk then
      return { ran = false, error = "loadstring: " .. tostring(lerr) }
    end
    -- Pause at an uncaught error with the frames still inspectable (the IDE
    -- opts in). Headless callers keep report-and-return: an unattended error
    -- must not hold the sim until the idle timeout.
    pause_on_error = pause_on_error == true

    local step_mode = nil -- "over" | "into" | "out" pending, or nil
    local step_depth = 0
    local last_drain = clock()

    -- The REAL stack depth, walked fresh (C frames counted too, consistently).
    -- Drift-proof where a call/return counter is not: Lua 5.1 fires no
    -- "return" hook for frames unwound by error(), so a pcall-caught error
    -- inside the debuggee permanently skews a counter and step over/out then
    -- compares against a stale baseline (degrading into "continue"). Walked
    -- only when a step is armed or checked — plain breakpoint lines never pay
    -- for it. Level 2 skips real_depth itself, so the result is relative to
    -- the CALLER — always the hook body, one consistent frame of reference.
    local function real_depth()
      local l = 2
      while debug.getinfo(l, "") do
        l = l + 1
      end
      return l
    end

    -- Snapshot the full Lua call stack from `base` upward, capturing each
    -- frame's locals + upvalues as scopes. Values are captured NOW (the stack
    -- is only valid here); tables expand lazily later via their refs. Leading
    -- C frames are skipped (an error handler sits above the throw machinery);
    -- after Lua code, the first C frame — the pcall that ran the chunk — stops
    -- the walk. `reason`/`err` mark an error pause ("Paused on error").
    local function snapshot(base, reason, err)
      dbg.vars = {}
      dbg.n = 0
      dbg.envs = {} -- per-frame eval env (locals/upvals + presence) for eval()
      dbg.frame_funcs = {} -- per-frame function: setupvalue + live-frame matching
      local frames = {}
      local level = base
      local seen_lua = false
      while true do
        local info = debug.getinfo(level, "nSlf")
        if not info then break end
        if info.what == "C" then
          if seen_lua then break end -- the pcall boundary: stop
          level = level + 1 -- error/throw machinery above the top frame: skip
        else
          seen_lua = true
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
          dbg.frame_funcs[idx] = info.func
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
      end
      -- pause_id: a monotonic stop counter so the editor refreshes variables on
      -- EVERY distinct stop (incl. re-pausing on the same line in a loop), not
      -- only when the line moves. cond_error: a conditional-breakpoint error,
      -- surfaced rather than silently swallowed.
      return bridge.json.safe_encode({
        frames = frames,
        pause_id = dbg.pause_id,
        cond_error = dbg.cond_error,
        stop_reason = reason,
        error = err,
      })
    end

    -- Hold a pause: pump RPC so the editor can inspect/step while the world is
    -- frozen; auto-continue after DEBUG_IDLE_SECONDS with no client polling (a
    -- vanished editor must never freeze the sim forever). Returns the resume
    -- mode, with the pause cleared and the per-pause refs released.
    local function hold_pause()
      local mode = nil
      dbg.last_ping = clock() -- the editor just requested this stop; it's alive
      repeat
        D.pump() -- a debug_state during this drain refreshes last_ping
        mode = bridge.debug.take_resume()
        if not mode and (clock() - dbg.last_ping) > DEBUG_IDLE_SECONDS then
          mode = "continue" -- the editor stopped polling (gone): don't freeze forever
        end
      until mode ~= nil
      bridge.debug.clear_paused()
      dbg.vars = {} -- release captured values; refs are per-pause
      dbg.n = 0
      return mode
    end

    local hook = function(_, line)
      -- "l" mask: every event is a line event. Depth is walked on demand
      -- (real_depth), never counted off call/return events.
      local info = debug.getinfo(2, "nSlf")
      local src = (info and info.source) or source
      -- Throttled RPC drain DURING the run, so a manual Pause/Stop (and live
      -- state queries) are delivered even while the chunk holds the sim thread.
      -- The hook is disabled while it runs, so this re-entrant drain is safe.
      local now = clock()
      if (now - last_drain) > DRAIN_INTERVAL_SECONDS then
        last_drain = now
        D.pump()
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
      if not hit and step_mode then
        if step_mode == "into" then
          hit = true
        else
          local d = real_depth()
          if step_mode == "over" then
            hit = d <= step_depth
          else -- "out"
            hit = d < step_depth
          end
        end
      end
      if hit then
        step_mode = nil
        dbg.pause_id = (dbg.pause_id or 0) + 1 -- distinct-stop id (drives editor refresh)
        -- snapshot from level 3: the chunk frame is snapshot(1) <- hook(2) <- chunk(3).
        bridge.debug.set_paused(snapshot(3))
        local mode = hold_pause()
        if mode == "step_over" or mode == "step_into" or mode == "step_out" then
          step_mode = string.sub(mode, 6) -- "over" | "into" | "out"
          -- Armed from the hook body, checked from the hook body: real_depth's
          -- caller-relative count keeps one frame of reference for both.
          step_depth = real_depth()
        else
          step_mode = nil -- continue: only breakpoints pause again
        end
      end
    end
    dbg.hook_fn = hook -- the live-stack anchor eval()'s setlocal walk finds

    -- Uncaught-error handler: runs ABOVE the still-live erroring frames, so it
    -- can capture the traceback (a bare pcall loses it) and — when the IDE
    -- opted in — hold a "Paused on error" stop with the frames inspectable,
    -- IntelliJ's break-on-uncaught-exception. The hook comes off first:
    -- stepping after a throw is meaningless, and the pause pump must not
    -- re-enter it. Any resume ends the run — the error still propagates.
    local function on_error(msg)
      debug.sethook()
      local text = tostring(msg)
      if pause_on_error and not string.find(text, "debug: stopped", 1, true) then
        dbg.pause_id = (dbg.pause_id or 0) + 1
        bridge.debug.set_paused(snapshot(3, "error", text))
        hold_pause()
      end
      local trace = debug.traceback(text, 2)
      -- Trim the debugger's own machinery (xpcall and everything below it —
      -- the RPC pump) off the tail: the user's crash ends at their code.
      local cut = string.find(trace, "\n%s*%[C%]: in function 'xpcall'")
      if cut then
        trace = string.sub(trace, 1, cut - 1)
      end
      return trace
    end

    -- Session liveness is reported via debug_state (running / error), so the
    -- editor detects the end by polling rather than by awaiting this call —
    -- which it can't, since the run blocks for the whole session and the
    -- client's per-call timeout would otherwise fire on a long run or pause.
    D.running = true
    D.error = nil
    dbg.cond_error = nil
    dbg.pause_id = 0
    -- Clear any stale break-all / resume / pause from a prior session so it
    -- can't phantom-break this run on its first line.
    bridge.debug.reset_session()
    dbg.last_ping = clock()
    -- Capture print for the debugged run by swapping AROUND the xpcall (no
    -- wrapping pcall — on_error must snapshot the crash frames live). The shim is
    -- rt.lua's shared print_shim (RT is installed before this engine); the
    -- console ring is the sink.
    local prev_print = _G.print
    _G.print = __DCS_STUDIO_RT.print_shim(bridge.console.print, prev_print)
    debug.sethook(hook, "l") -- line events only; depth is walked, never counted
    local ran_ok, run_err = xpcall(chunk, on_error)
    debug.sethook() -- always remove the scoped hook (double-off is harmless)
    _G.print = prev_print
    dbg.hook_fn = nil
    D.running = false
    if not ran_ok then
      local msg = tostring(run_err)
      -- A user Stop unwinds via error() but is a clean end, not a failure.
      if not string.find(msg, "debug: stopped", 1, true) then
        D.error = msg -- message + full traceback (on_error)
      end
      return { ran = false, error = D.error }
    end
    return { ran = true }
  end

  __DCS_STUDIO_DBG = D
end
