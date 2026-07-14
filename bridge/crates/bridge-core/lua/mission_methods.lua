-- DCS Studio mission-bridge method registration. Embedded in
-- dcs_studio_mission.dll (include_str!) and exposed as `bridge.register_methods`;
-- mission_init.lua calls it to populate its router, and the headless OpenRPC
-- golden test runs the SAME chunk against a stub router — so the checked-in
-- openrpc document cannot drift from what the DLL registers.
--
-- `deps` injects the touchpoints a headless test cannot provide: the exports
-- table (`deps.bridge`), the debug engine (`deps.D`, may be nil), and the
-- console runtime (`deps.RT`). Live globals (timer, lfs, env, __DCS_STUDIO_WRITEDIR)
-- are read from inside handler bodies only, never at registration time, so
-- registering against a stub router needs no mission API at all.
return function(router, deps)
  local bridge = deps.bridge
  local D = deps.D
  local RT = deps.RT

  -- A `print` replacement that pipes into this DLL's console ring (tailed by
  -- the IDE via console_read on THIS bridge) AS WELL AS the original sink.
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
  -- debug_run: the engine swaps print around its own xpcall instead.
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

  router:add_method("ping", function()
    return { pong = true, dcs_time = (type(timer) == "table" and timer.getTime and timer.getTime()) or 0 }
  end, {
    description = "Liveness check. dcs_time is mission model time; it stops advancing while the sim is paused. NOTE: this bridge's queue pump runs on model time too — requests queue (until the 30s server timeout) while the sim is paused or between missions.",
  })

  router:add_method("eval", function(params)
    local f, err = loadstring(params.code)
    if not f then
      error("loadstring: " .. tostring(err))
    end
    return with_print_capture(f)
  end, {
    description = "Run Lua in the mission scripting state and return the result. print() output streams into console_read.",
    params = { { name = "code", type = "string", required = true, description = "Lua source to run." } },
  })

  router:add_method("console_read", function(params)
    return bridge.console.read((params and params.after) or 0)
  end, {
    description = "Lines printed in the mission state since sequence `after` (0/absent = from the start), as { lines = { { seq, text }, ... }, latest }. Each bridge has its own ring: mission prints are only readable here.",
    params = { { name = "after", type = "number", required = false } },
  })

  router:add_method("emit_dlua", function()
    return { dlua = bridge.emit_dlua() }
  end, {
    description = "The generated EmmyLua (.d.lua) type definitions for this bridge's own Lua surface.",
  })

  router:add_method("dump_globals", function()
    return { dlua = bridge.dump_globals() }
  end, {
    description = "Introspect the live mission-state API in _G (env, timer, trigger, world, coalition, ...) as dotted .d.lua statements.",
  })

  -- Console/REPL explorer: this bridge serves ONE environment (the mission
  -- state), so there is no env parameter — the runtime runs right here.
  -- Remote print() output rides in the envelope and is fed to the console ring.
  local function rt_envelope(json_text)
    local tbl = bridge.json.decode(json_text)
    if type(tbl) ~= "table" then
      error("mission runtime returned: " .. string.sub(tostring(json_text), 1, 400), 0)
    end
    if type(tbl.prints) == "table" then
      for _, line in ipairs(tbl.prints) do
        bridge.console.print(line)
      end
      tbl.prints = nil
    end
    return tbl
  end

  router:add_method("repl_eval", function(params)
    return rt_envelope(RT.eval_json((params and params.code) or ""))
  end, {
    description = "Console eval in the mission state: { ok, result?, err? }.",
    params = { { name = "code", type = "string", required = true } },
  })

  router:add_method("repl_inspect", function(params)
    return rt_envelope(RT.inspect_json((params and params.expr) or ""))
  end, {
    description = "Evaluate an expression and register the result for lazy drill-down: { ok, type, value, ref }.",
    params = { { name = "expr", type = "string", required = true } },
  })

  router:add_method("repl_expand", function(params)
    return rt_envelope(RT.expand_json((params and params.ref) or 0))
  end, {
    description = "Expand a ref handed out by repl_inspect/repl_expand: { ok, variables }.",
    params = { { name = "ref", type = "number", required = true } },
  })

  router:add_method("repl_signature", function(params)
    return rt_envelope(RT.signature_json((params and params.ref) or 0))
  end, {
    description = "Resolve a function ref's real parameter names (never runs the function): { ok, params?, native?, err? }.",
    params = { { name = "ref", type = "number", required = true } },
  })

  router:add_method("repl_clear", function()
    return rt_envelope(RT.clear_json())
  end, {
    description = "Drop every explorer ref held by this state.",
  })

  -- Full-JSON export to a file under <writedir>Temp\ — a file, not a response
  -- payload, so a mission-DB-sized export never rides the WebSocket. Uses the
  -- DLL's guarded file writer: io/lfs may be sanitized away in this state.
  local export_n = 0
  router:add_method("repl_export", function(params)
    local res
    if params and params.ref and params.ref > 0 then
      res = RT.export_json(nil, params.ref)
    else
      res = RT.export_json((params and params.expr) or "", nil)
    end
    if string.sub(res, 1, 4) == "ERR:" then
      error(string.sub(res, 5), 0)
    end
    if string.sub(res, 1, 3) ~= "OK:" then
      error("export failed: " .. string.sub(res, 1, 400), 0)
    end
    local json = string.sub(res, 4)
    export_n = export_n + 1
    local stamp = math.floor(((type(timer) == "table" and timer.getAbsTime and timer.getAbsTime()) or 0) * 1000)
    local rel = "Temp/dcs-studio-export-" .. stamp .. "-" .. export_n .. ".json"
    local ok, werr = bridge.file.write_text(rel, json)
    if not ok then
      error("cannot write export: " .. tostring(werr), 0)
    end
    local writedir = (type(lfs) == "table" and lfs.writedir and lfs.writedir()) or __DCS_STUDIO_WRITEDIR or ""
    return { path = writedir .. string.gsub(rel, "/", "\\"), bytes = #json }
  end, {
    description = "Write the full JSON of a value (by ref or expression) to a file under <writedir>Temp\\ and return { path, bytes }.",
    params = {
      { name = "expr", type = "string", required = false },
      { name = "ref", type = "number", required = false },
    },
  })

  -- Debugger: drives __DCS_STUDIO_DBG in THIS state. Breakpoints live in this
  -- DLL's statics — the IDE must send them to this bridge for mission code.
  local function need_debugger()
    if not D then
      error("the debug library is not available in the mission state - breakpoints cannot work here", 0)
    end
    return D
  end

  router:add_method("debug_run", function(params)
    return need_debugger().run(
      (params and params.code) or "",
      (params and params.source) or "=debug",
      params and params.pause_on_error == true
    )
  end, {
    description = "Run a chunk under the debugger in the mission state. Blocks for the whole session (the engine answers this bridge's RPCs itself while running/paused); poll debug_state instead of awaiting this call.",
    params = {
      { name = "code", type = "string", required = true },
      { name = "source", type = "string", required = false, description = "Chunkname; \"=<abs path>\" lines breakpoints up with the IDE." },
      { name = "pause_on_error", type = "boolean", required = false },
    },
  })

  router:add_method("debug_state", function()
    return need_debugger().state()
  end, {
    description = "Poll the session: { paused, running, snapshot?, error? }. Also the liveness signal that keeps a held pause alive.",
  })

  router:add_method("debug_continue", function(params)
    bridge.debug.request_resume((params and params.mode) or "continue")
    return { ok = true, mode = (params and params.mode) or "continue" }
  end, {
    description = "Resume a paused session: mode continue | step_over | step_into | step_out.",
    params = { { name = "mode", type = "string", required = false } },
  })

  router:add_method("debug_pause", function()
    bridge.debug.request_pause()
    return { ok = true }
  end, {
    description = "Break at the next line of debugged code (manual pause).",
  })

  router:add_method("debug_stop", function()
    bridge.debug.request_stop()
    bridge.debug.request_resume("continue")
    return { ok = true }
  end, {
    description = "Terminate the running chunk (unwinds a runaway/looping run).",
  })

  router:add_method("debug_expand", function(params)
    return need_debugger().expand((params and params.ref) or 0)
  end, {
    description = "Lazily expand a variables/scope ref from the pause snapshot or the inspector.",
    params = { { name = "ref", type = "number", required = true } },
  })

  router:add_method("debug_eval", function(params)
    return need_debugger().eval((params and params.frame) or 0, (params and params.expr) or "")
  end, {
    description = "Evaluate an expression in a paused frame (locals → upvalues → globals). A top-level `name = value` assigns for real.",
    params = {
      { name = "frame", type = "number", required = false },
      { name = "expr", type = "string", required = true },
    },
  })

  router:add_method("debug_inspect", function(params)
    return need_debugger().inspect((params and params.expr) or "")
  end, {
    description = "Evaluate an expression against the live mission globals and register the result for lazy exploration (no pause needed).",
    params = { { name = "expr", type = "string", required = true } },
  })

  router:add_method("debug_inspect_clear", function()
    return need_debugger().inspect_clear()
  end, {
    description = "Drop every inspection ref, releasing the held values.",
  })

  router:add_method("debug_set_breakpoints", function(params)
    return need_debugger().set_breakpoints(params)
  end, {
    description = "Replace one source's breakpoints (+ per-line conditions): { source, breakpoints = { { line, condition? }, ... } }.",
    params = {
      { name = "source", type = "string", required = true },
      { name = "breakpoints", type = "array", required = true },
    },
  })

  router:add_method("debug_clear_breakpoints", function()
    return need_debugger().clear_breakpoints()
  end, {
    description = "Drop every breakpoint and condition held by this bridge.",
  })
end
