-- DCS Studio GUI-bridge method registration. Embedded in dcs_studio_gui.dll
-- (include_str!) and exposed as `bridge.register_methods`; the GameGUI hook
-- (bridge/hook/DcsStudio.lua) calls it to populate its router, and the
-- headless OpenRPC golden test runs the SAME chunk against a stub router — so
-- the checked-in openrpc document cannot drift from what the DLL registers.
--
-- `deps` injects the touchpoints a headless test cannot provide: the exports
-- table (`deps.bridge`), the debug engine (`deps.DBG`), and the console runtime
-- (`deps.RT`). Everything else (DCS, net, lfs, db, io, os) is read as a live
-- global from inside a handler body — never at registration time — so
-- registering the methods against a stub router needs no DCS API at all.
--
-- Returns { dispatch_mission_boot, mission_boot_tick } for the hook's
-- onSimulation* callbacks.
return function(router, deps)
  local bridge = deps.bridge
  local DBG = deps.DBG

  router:add_method("ping", function()
    return { pong = true, dcs_time = (DCS.getModelTime and DCS.getModelTime()) or 0 }
  end, {
    description = "Liveness check. dcs_time is mission model time (0 at the main menu).",
  })

  -- A `print` replacement that pipes into the DCS Studio console
  -- (bridge.console) AS WELL AS the original sink, so editor-driven runs
  -- stream their print-debugging into the IDE's Console panel like a
  -- terminal.
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
  -- debug_run: the inner pcall here would unwind a crash before the error
  -- handler could snapshot the live frames — debug_run swaps print around
  -- its own xpcall instead.
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

  -- Run arbitrary Lua in the GUI/hooks environment and return the result.
  -- localhost-only by the server bind; gives full DCS.*/net.* control
  -- (e.g. start missions, DCS.exitProcess()) for the editor and dev tooling.
  router:add_method("eval", function(params)
    local f, lerr = loadstring(params.code)
    if not f then
      error("loadstring: " .. tostring(lerr))
    end
    return with_print_capture(f)
  end, {
    description = "Run Lua in the GUI/hooks state (DCS.*, net.*) and return the result. print() output streams into console_read. For the mission state use the mission bridge on port 25570.",
    params = { { name = "code", type = "string", required = true, description = "Lua source to run." } },
  })

  -- The IDE's console tail: lines printed since `after` (see console.read).
  router:add_method("console_read", function(params)
    return bridge.console.read(params and params.after or 0)
  end, {
    description = "Lines printed in the GUI state since sequence `after` (0/absent = from the start), as { lines = { { seq, text }, ... }, latest }. The mission bridge has its own ring on port 25570.",
    params = { { name = "after", type = "number", required = false } },
  })

  -- Live type sync (issue #50). The DLL describes its own Lua surface and the
  -- live DCS API as `.d.lua` the editor's lua-analyzer indexes — emitted from
  -- inside the running sim, so hover/diagnostics match the EXACT loaded build,
  -- not an app-build snapshot. Both answer from boot (no mission required);
  -- dump_globals re-introspects `_G` per call, so it reflects whatever the sim
  -- currently exposes. Returned as { dlua = ... } per model TypeDefs.
  router:add_method("emit_dlua", function()
    return { dlua = bridge.emit_dlua() }
  end, {
    description = "The generated EmmyLua (.d.lua) type definitions for this bridge's own Lua surface.",
  })

  router:add_method("dump_globals", function()
    return { dlua = bridge.dump_globals() }
  end, {
    description = "Introspect the live GUI-state API in _G (DCS, Export, net, lfs, log) as dotted .d.lua statements.",
  })

  -- The console/REPL runtime (__DCS_STUDIO_RT) is installed into this state by
  -- the DLL itself; bridge.rt_source carries the same source for injecting
  -- into the remote net states, which self-install it (idempotent via the
  -- version guard) — a fresh state heals itself on the next call.
  --
  -- Environments the console can target HERE. "gui" runs in this hooks env;
  -- server/config/export are DCS Lua states reached synchronously with
  -- net.dostring_in. "mission" is served by the mission bridge on port 25570,
  -- not here — DCS 2.9.27 pointed dostring_in("mission") at a trigger sandbox
  -- whose a_do_script is fire-and-forget (no return value).
  local REPL_ENVS = { gui = true, server = true, config = true, export = true }
  local MISSION_MOVED = "the 'mission' environment is served by the mission bridge on 127.0.0.1:25570 "
    .. "(it runs while a mission is up and needs a desanitized MissionScripting.lua)"

  local function repl_env(params)
    local envname = (params and params.env) or "gui"
    if envname == "mission" then
      error(MISSION_MOVED, 0)
    end
    if not REPL_ENVS[envname] then
      error("unknown environment '" .. tostring(envname) .. "'", 0)
    end
    return envname
  end

  -- Run `__DCS_STUDIO_RT.<callexpr>` in `envname` and return its JSON string.
  -- Remote calls prepend rt_source so a fresh state self-installs the runtime
  -- before answering; refs handed out by inspect/expand live INSIDE that state
  -- and stay valid until repl_clear or the state is torn down.
  local function rt_call(envname, callexpr)
    if envname == "gui" then
      local f = assert(loadstring("return __DCS_STUDIO_RT." .. callexpr))
      return f()
    end
    local src = bridge.rt_source .. "\nreturn __DCS_STUDIO_RT." .. callexpr
    local res = net.dostring_in(envname, src)
    if type(res) ~= "string" or res == "" then
      error("no result from the '" .. envname .. "' environment", 0)
    end
    return res
  end

  -- Envelope decode; remote print() output rides in the envelope and is fed
  -- to the console ring here so it streams to the IDE like local prints.
  local function decode_envelope(envname, res)
    local tbl = bridge.json.decode(res)
    if type(tbl) ~= "table" then
      -- Not our envelope: dostring_in handed back an error string — surface it.
      error("'" .. envname .. "' returned: " .. string.sub(res, 1, 400), 0)
    end
    if type(tbl.prints) == "table" then
      for _, line in ipairs(tbl.prints) do
        bridge.console.print(line)
      end
      tbl.prints = nil
    end
    return tbl
  end

  local function rt_envelope(envname, callexpr)
    return decode_envelope(envname, rt_call(envname, callexpr))
  end

  local REPL_ENV_META = {
    name = "env",
    type = "string",
    required = false,
    description = "gui (default) | server | config | export. mission → use port 25570.",
  }

  -- Env-aware console (the Lua Console panel). repl_eval runs code in the
  -- chosen environment and returns { ok, result?, err? }; repl_inspect /
  -- repl_expand / repl_clear are the lazy table explorer; repl_export writes
  -- the full JSON of a value to a temp file and returns its path — a file, not
  -- a response payload, so a huge export never rides the WebSocket.
  router:add_method("repl_eval", function(params)
    local envname = repl_env(params)
    return rt_envelope(envname, string.format("eval_json(%q)", (params and params.code) or ""))
  end, {
    description = "Console eval in the chosen environment: { ok, result?, err? }.",
    params = { { name = "code", type = "string", required = true }, REPL_ENV_META },
  })

  router:add_method("repl_inspect", function(params)
    local envname = repl_env(params)
    return rt_envelope(envname, string.format("inspect_json(%q)", (params and params.expr) or ""))
  end, {
    description = "Evaluate an expression and register the result for lazy drill-down: { ok, type, value, ref }.",
    params = { { name = "expr", type = "string", required = true }, REPL_ENV_META },
  })

  router:add_method("repl_expand", function(params)
    local envname = repl_env(params)
    return rt_envelope(envname, string.format("expand_json(%d)", (params and params.ref) or 0))
  end, {
    description = "Expand a ref handed out by repl_inspect/repl_expand: { ok, variables }.",
    params = { { name = "ref", type = "number", required = true }, REPL_ENV_META },
  })

  router:add_method("repl_signature", function(params)
    local envname = repl_env(params)
    return rt_envelope(envname, string.format("signature_json(%d)", (params and params.ref) or 0))
  end, {
    description = "Resolve a function ref's real parameter names (never runs the function): { ok, params?, native?, err? }.",
    params = { { name = "ref", type = "number", required = true }, REPL_ENV_META },
  })

  router:add_method("repl_clear", function(params)
    return rt_envelope(repl_env(params), "clear_json()")
  end, {
    description = "Drop every explorer ref held by the chosen environment.",
    params = { REPL_ENV_META },
  })

  local export_n = 0
  local function finalize_export(res)
    if string.sub(res, 1, 4) == "ERR:" then
      error(string.sub(res, 5), 0)
    end
    if string.sub(res, 1, 3) ~= "OK:" then
      error("export failed: " .. string.sub(res, 1, 400), 0)
    end
    local json = string.sub(res, 4)
    local dir = lfs.writedir() .. "Temp\\"
    pcall(lfs.mkdir, dir)
    export_n = export_n + 1
    local path = dir .. "dcs-studio-export-" .. os.time() .. "-" .. export_n .. ".json"
    local fh, ferr = io.open(path, "wb")
    if not fh then
      error("cannot write " .. path .. ": " .. tostring(ferr), 0)
    end
    fh:write(json)
    fh:close()
    return { path = path, bytes = #json }
  end

  router:add_method("repl_export", function(params)
    local envname = repl_env(params)
    local callexpr
    if params and params.ref and params.ref > 0 then
      callexpr = string.format("export_json(nil, %d)", params.ref)
    else
      callexpr = string.format("export_json(%q, nil)", (params and params.expr) or "")
    end
    return finalize_export(rt_call(envname, callexpr))
  end, {
    description = "Write the full JSON of a value (by ref or expression) to a file under <writedir>Temp\\ and return { path, bytes }.",
    params = {
      { name = "expr", type = "string", required = false },
      { name = "ref", type = "number", required = false },
      REPL_ENV_META,
    },
  })

  -- ── Mission bridge boot ──
  -- The mission scripting state is reachable from here only through a
  -- deferred, valueless a_do_script (DCS ≥ 2.9.27) — so instead of tunnelling
  -- work through it, dispatch a tiny boot snippet that require()s the mission
  -- DLL into that state. The DLL then runs its own JSON-RPC server on 25570
  -- and the IDE talks to it directly. require() needs a desanitized
  -- MissionScripting.lua; the snippet reports a clear error into dcs.log
  -- otherwise. Idempotent: __DCS_STUDIO_MISSION_BOOTED guards the re-dispatch
  -- and the mission DLL's server start is reusable across missions.
  local function mission_boot_source()
    local writedir = lfs.writedir()
    return string.format(
      [==[
if not __DCS_STUDIO_MISSION_BOOTED then
  local function fail(msg)
    if env and env.error then env.error("DCS Studio: " .. msg, true) end
  end
  if type(require) ~= "function" or type(package) ~= "table" then
    fail("mission scripting is sanitized (require/package are nil). Run 'DCS Studio: Desanitize MissionScripting.lua', restart DCS, then start the mission again.")
  else
    __DCS_STUDIO_WRITEDIR = %q
    package.cpath = package.cpath .. ";" .. %q
    local ok2, err2 = pcall(require, "dcs_studio_mission")
    if ok2 then
      __DCS_STUDIO_MISSION_BOOTED = true
    else
      fail("cannot load dcs_studio_mission.dll in the mission state: " .. tostring(err2))
    end
  end
end
]==],
      writedir,
      writedir .. "Mods\\tech\\DcsStudio\\bin\\?.dll"
    )
  end

  local boot_at = 0 -- last dispatch (os.clock); rate-limits the frame retry

  local function dispatch_mission_boot()
    boot_at = os.clock()
    -- Fire-and-forget into the real mission state via the trigger sandbox's
    -- a_do_script. No return value: success is observable as port 25570
    -- coming up; failures land in dcs.log via the snippet's env.error.
    pcall(net.dostring_in, "mission", string.format("a_do_script(%q)", mission_boot_source()))
  end

  router:add_method("mission_boot", function()
    dispatch_mission_boot()
    return { dispatched = true }
  end, {
    description = "Re-dispatch the mission-bridge boot into the mission scripting state (fire-and-forget; needs a running mission and a desanitized MissionScripting.lua). Success = port 25570 answering; failures land in dcs.log.",
  })

  -- Debugger for GUI sessions. The engine (__DCS_STUDIO_DBG) is installed
  -- into this state by the DLL; the hook wires its RPC pump — during a
  -- pause the engine drains this server's queue itself through this router,
  -- because onSimulationFrame cannot fire while the paused chunk holds the
  -- sim thread. Mission sessions talk to the mission bridge on 25570.

  router:add_method("debug_run", function(params)
    local envname = (params and params.env) or "gui"
    if envname ~= "gui" then
      error(
        "debug env '" .. tostring(envname) .. "' is not served here — mission debugging talks to the mission bridge on 127.0.0.1:25570",
        0
      )
    end
    return DBG.run(
      (params and params.code) or "",
      (params and params.source) or "=debug",
      params and params.pause_on_error == true
    )
  end, {
    description = "Run a chunk under the debugger in the GUI state. Blocks for the whole session (the engine answers this bridge's RPCs itself while running/paused); poll debug_state instead of awaiting this call.",
    params = {
      { name = "code", type = "string", required = true },
      { name = "source", type = "string", required = false, description = 'Chunkname; "=<abs path>" lines breakpoints up with the IDE.' },
      { name = "pause_on_error", type = "boolean", required = false },
      { name = "env", type = "string", required = false, description = "Must be gui here; mission → port 25570." },
    },
  })

  router:add_method("debug_state", function()
    return DBG.state()
  end, {
    description = "Poll the session: { paused, running, snapshot?, error? }. Also the liveness signal that keeps a held pause alive.",
  })

  router:add_method("debug_expand", function(params)
    return DBG.expand((params and params.ref) or 0)
  end, {
    description = "Lazily expand a variables/scope ref from the pause snapshot or the inspector.",
    params = { { name = "ref", type = "number", required = true } },
  })

  router:add_method("debug_eval", function(params)
    return DBG.eval((params and params.frame) or 0, (params and params.expr) or "")
  end, {
    description = "Evaluate an expression in a paused frame (locals → upvalues → globals). A top-level `name = value` assigns for real.",
    params = {
      { name = "frame", type = "number", required = false },
      { name = "expr", type = "string", required = true },
    },
  })

  router:add_method("debug_inspect", function(params)
    return DBG.inspect((params and params.expr) or "")
  end, {
    description = "Evaluate an expression against the live GUI globals and register the result for lazy exploration (no pause needed).",
    params = { { name = "expr", type = "string", required = true } },
  })

  router:add_method("debug_inspect_clear", function()
    return DBG.inspect_clear()
  end, {
    description = "Drop every inspection ref, releasing the held values.",
  })

  -- Replace one source's breakpoints (+ per-line conditions). The registry
  -- lives in THIS DLL's statics: it applies to GUI sessions only — mission
  -- breakpoints go to the mission bridge.
  router:add_method("debug_set_breakpoints", function(params)
    return DBG.set_breakpoints(params)
  end, {
    description = "Replace one source's breakpoints (+ per-line conditions) for GUI sessions: { source, breakpoints = { { line, condition? }, ... } }.",
    params = {
      { name = "source", type = "string", required = true },
      { name = "breakpoints", type = "array", required = true },
    },
  })

  router:add_method("debug_clear_breakpoints", function()
    return DBG.clear_breakpoints()
  end, {
    description = "Drop every breakpoint and condition held by this bridge.",
  })

  router:add_method("debug_continue", function(params)
    local mode = (params and params.mode) or "continue"
    bridge.debug.request_resume(mode)
    return { ok = true, mode = mode }
  end, {
    description = "Resume a paused session: mode continue | step_over | step_into | step_out.",
    params = { { name = "mode", type = "string", required = false } },
  })

  -- Manual Pause / break-all: stop at the next line of debugged code. Delivered
  -- to the busy sim thread via the engine's throttled drain.
  router:add_method("debug_pause", function()
    bridge.debug.request_pause()
    return { ok = true }
  end, {
    description = "Break at the next line of debugged code (manual pause).",
  })

  -- Stop: terminate the running chunk. Request the unwind, and release the pump
  -- with a continue so a paused session resumes straight into the stop check.
  router:add_method("debug_stop", function()
    bridge.debug.request_stop()
    bridge.debug.request_resume("continue")
    return { ok = true }
  end, {
    description = "Terminate the running chunk (unwinds a runaway/looping run).",
  })

  -- ── DCS unit database (db) ──
  -- The GameGUI hook state carries a rich `db` global directly (Units, Weapons,
  -- …). These methods are GUI-bridge only and need the sim loaded; every
  -- handler guards `type(db) == "table"`. Returns are plain data tables (no
  -- cycles) safe for the Rust serializer, EXCEPT db_export which writes a file.
  local RT = deps.RT

  local DB_CAP = 2000 -- max rows a listing returns before it flags `truncated`
  local RAW_MAX_DEPTH = 12 -- db_unit raw / guns sanitizer recursion guard

  local function need_db()
    if type(db) ~= "table" then
      error(
        "the DCS unit database (db) is not available here — db_* methods are GUI-bridge only and need DCS loaded (the sim must be foreground so its RPC queue pumps)",
        0
      )
    end
  end

  -- Detect a real unit category inside a `db.Units` child: the child holds an
  -- array-of-records under a singular key (Planes→Plane, Cars→Car), and a real
  -- unit record's `.type` is a STRING (this is what excludes GT_t, whose
  -- WSN_t[i].type is a number, plus Skills/WWIIstructures which have no such
  -- inner array). Returns entry_key, array or nil.
  local function detect_category(child)
    for k, v in pairs(child) do
      if type(v) == "table" and #v > 0 and type(v[1]) == "table" and type(v[1].type) == "string" then
        return tostring(k), v
      end
    end
    return nil
  end

  -- Category map + per-category type→record index, cached module-locally and
  -- rebuilt when `db` changes identity (a fresh db table on reload).
  local db_cache = nil
  local function get_cache()
    if db_cache and db_cache.db == db then
      return db_cache
    end
    local categories, by_name = {}, {}
    if type(db) == "table" and type(db.Units) == "table" then
      for name, child in pairs(db.Units) do
        if type(child) == "table" then
          local entry_key, arr = detect_category(child)
          if entry_key then
            local entry = {
              name = tostring(name),
              entry_key = entry_key,
              array = arr,
              count = #arr,
              type_index = nil,
            }
            categories[#categories + 1] = entry
            by_name[entry.name] = entry
          end
        end
      end
      table.sort(categories, function(a, b) return a.name < b.name end)
    end
    db_cache = { db = db, categories = categories, by_name = by_name }
    return db_cache
  end

  -- Lazy lowercase type→record index for one category.
  local function type_index(entry)
    if entry.type_index then
      return entry.type_index
    end
    local idx = {}
    for i = 1, #entry.array do
      local rec = entry.array[i]
      if type(rec) == "table" and type(rec.type) == "string" then
        idx[string.lower(rec.type)] = rec
      end
    end
    entry.type_index = idx
    return idx
  end

  -- Depth-capped, cycle-safe deep copy into plain data (functions/userdata/
  -- threads → their type name), so a raw record is safe for the Rust serializer
  -- (which has no cycle guard). Integer-keyed tables keep their keys, so arrays
  -- stay arrays.
  local function sanitize(v, depth, seen)
    local t = type(v)
    if t == "table" then
      if seen[v] then
        return "<cycle>"
      end
      if depth <= 0 then
        return "<max depth>"
      end
      seen[v] = true
      local out = {}
      for k, val in pairs(v) do
        local kk = (type(k) == "string" or type(k) == "number") and k or tostring(k)
        out[kk] = sanitize(val, depth - 1, seen)
      end
      seen[v] = nil
      return out
    elseif t == "function" or t == "userdata" or t == "thread" then
      return t
    end
    return v -- string / number / boolean / nil
  end

  -- Human-readable attribute names: a unit's `attribute` table mixes numeric
  -- ids and string names; the strings are the modder-facing attribute list.
  local function attribute_names(rec)
    local out = {}
    if type(rec.attribute) == "table" then
      for _, v in pairs(rec.attribute) do
        if type(v) == "string" then
          out[#out + 1] = v
        end
      end
      table.sort(out)
    end
    return out
  end

  -- Curated numeric performance fields, read defensively across categories
  -- (planes/helicopters/ships/cars use different subsets); only those present
  -- as numbers appear.
  local PERF_KEYS = {
    "Mach_max", "M_max", "M_empty", "M_fuel_max", "M_nominal",
    "V_max_h", "V_max_sea_level", "V_max", "V_max_cruise", "V_land", "V_take_off",
    "MaxSpeed", "max_velocity", "Vy_max",
    "H_max", "H_stat_max", "H_din_one_eng",
    "range", "detection_range_max", "DetectionRange", "ThreatRange",
    "mass", "life", "AmmoWeight",
    "length", "height", "wing_span", "Length", "Width", "Height",
    "RCS", "engines_count", "crew_members_count",
  }
  local function perf_fields(rec)
    local out = {}
    for _, key in ipairs(PERF_KEYS) do
      if type(rec[key]) == "number" then
        out[key] = rec[key]
      end
    end
    return out
  end

  -- Resolve a store CLSID against db.Weapons.ByCLSID → curated weapon info, or
  -- nil when unknown (the caller keeps the bare CLSID).
  local function resolve_weapon(clsid)
    local by = type(db.Weapons) == "table" and db.Weapons.ByCLSID
    local w = type(by) == "table" and by[clsid]
    if type(w) ~= "table" then
      return nil
    end
    return { display_name = w.displayName, name = w.name, category = w.category }
  end

  -- Pylons → per-pylon compatible stores (the DB's answer to "payloads":
  -- pylons + per-pylon store CLSIDs cross-referenced against db.Weapons; ME
  -- loadout PRESETS are not in db).
  local function pylons_of(rec)
    if type(rec.Pylons) ~= "table" then
      return nil
    end
    local out = {}
    for i = 1, #rec.Pylons do
      local p = rec.Pylons[i]
      if type(p) == "table" then
        local stores = {}
        if type(p.Launchers) == "table" then
          for j = 1, #p.Launchers do
            local l = p.Launchers[j]
            if type(l) == "table" and l.CLSID then
              stores[#stores + 1] = { clsid = l.CLSID, weapon = resolve_weapon(l.CLSID) }
            end
          end
        end
        out[#out + 1] = {
          number = p.Number,
          order = p.Order,
          type = p.Type,
          position = { x = p.X, y = p.Y, z = p.Z },
          stores = stores,
        }
      end
    end
    return out
  end

  router:add_method("db_categories", function()
    need_db()
    local cats = {}
    for _, entry in ipairs(get_cache().categories) do
      cats[#cats + 1] = { name = entry.name, entry_key = entry.entry_key, count = entry.count }
    end
    return { categories = cats }
  end, {
    summary = "List the DCS unit-database categories.",
    description = "The real categories inside db.Units (Planes, Helicopters, Ships, Cars, …), shape-detected and filtered (GT_t/Skills and non-unit children are skipped). GUI bridge only; needs DCS loaded.",
    result = { name = "categories", type = "table", description = "{ categories = { { name, entry_key, count }, ... } }" },
  })

  router:add_method("db_unit_types", function(params)
    need_db()
    local want_cat = params and params.category
    local filter = params and params.filter and string.lower(tostring(params.filter))
    local cache = get_cache()
    local list, categories
    if want_cat then
      local entry = cache.by_name[tostring(want_cat)]
      if not entry then
        error("unknown category '" .. tostring(want_cat) .. "' (see db_categories)", 0)
      end
      categories = { entry }
    else
      categories = cache.categories
    end
    local units, truncated = {}, false
    for _, entry in ipairs(categories) do
      for i = 1, #entry.array do
        local rec = entry.array[i]
        if type(rec) == "table" and type(rec.type) == "string" then
          local display = rec.DisplayName or rec.Name or rec.type
          if not filter or string.find(string.lower(rec.type), filter, 1, true)
            or string.find(string.lower(tostring(display)), filter, 1, true) then
            if #units >= DB_CAP then
              truncated = true
              break
            end
            units[#units + 1] = { type = rec.type, display_name = display, category = entry.name }
          end
        end
      end
      if truncated then
        break
      end
    end
    return { units = units, truncated = truncated }
  end, {
    summary = "List unit types (optionally one category, optionally filtered).",
    description = "Light listing across one or all categories: { units = { { type, display_name, category }, ... }, truncated }. `filter` is a case-insensitive substring over type/display name; capped at 2000 rows.",
    params = {
      { name = "category", type = "string", required = false, description = "Restrict to one category (name from db_categories)." },
      { name = "filter", type = "string", required = false, description = "Case-insensitive substring over type/display name." },
    },
    result = { name = "units", type = "table", description = "{ units = { { type, display_name, category }, ... }, truncated }" },
  })

  router:add_method("db_unit", function(params)
    need_db()
    local want = params and params.type
    if type(want) ~= "string" or want == "" then
      error("db_unit needs a `type` (a unit type name; see db_unit_types)", 0)
    end
    local lower = string.lower(want)
    local cache = get_cache()
    local rec, cat_name
    for _, entry in ipairs(cache.categories) do
      local hit = type_index(entry)[lower]
      if hit then
        rec, cat_name = hit, entry.name
        break
      end
    end
    if not rec then
      error("unknown unit type '" .. want .. "' (see db_unit_types)", 0)
    end
    if params and params.raw then
      return { unit = sanitize(rec, RAW_MAX_DEPTH, {}), category = cat_name, raw = true }
    end
    local crew = type(rec.crew_members) == "table" and #rec.crew_members or nil
    return {
      unit = {
        type = rec.type,
        display_name = rec.DisplayName or rec.Name or rec.type,
        category = cat_name,
        attributes = attribute_names(rec),
        country_of_origin = rec.country_of_origin,
        crew_members = crew,
        perf = perf_fields(rec),
        guns = type(rec.Guns) == "table" and sanitize(rec.Guns, RAW_MAX_DEPTH, {}) or nil,
        pylons = pylons_of(rec),
      },
    }
  end, {
    summary = "One unit record: curated summary, or the raw record.",
    description = "Curated: { unit = { type, display_name, category, attributes, country_of_origin, crew_members, perf, guns, pylons } } where pylons carry per-store CLSIDs resolved against db.Weapons. `raw = true` returns the whole record deep-copied through a depth-capped, cycle-safe sanitizer. NB: ME loadout presets are NOT in db — 'payloads' here means pylons + compatible stores.",
    params = {
      { name = "type", type = "string", required = true, description = "The unit type name (see db_unit_types)." },
      { name = "raw", type = "boolean", required = false, description = "Return the whole record (sanitized) instead of the curated view." },
    },
    result = { name = "unit", type = "table", description = "{ unit = { ... }, category?, raw? }" },
  })

  router:add_method("db_weapons", function(params)
    need_db()
    if type(db.Weapons) ~= "table" or type(db.Weapons.ByCLSID) ~= "table" then
      error("db.Weapons.ByCLSID is not available", 0)
    end
    local filter = params and params.filter and string.lower(tostring(params.filter))
    local weapons, truncated = {}, false
    for clsid, w in pairs(db.Weapons.ByCLSID) do
      if type(w) == "table" then
        local display = w.displayName or w.name or clsid
        local hay = string.lower(tostring(display) .. " " .. tostring(w.name or "") .. " " .. tostring(clsid))
        if not filter or string.find(hay, filter, 1, true) then
          if #weapons >= DB_CAP then
            truncated = true
            break
          end
          weapons[#weapons + 1] = {
            clsid = w.CLSID or clsid,
            display_name = display,
            name = w.name,
            category = w.category,
          }
        end
      end
    end
    return { weapons = weapons, truncated = truncated }
  end, {
    summary = "List weapons/stores from db.Weapons (CLSID + display name).",
    description = "Light listing of db.Weapons.ByCLSID: { weapons = { { clsid, display_name, name, category }, ... }, truncated }. `filter` is a case-insensitive substring over display name/name/CLSID; capped at 2000 rows.",
    params = {
      { name = "filter", type = "string", required = false, description = "Case-insensitive substring over display name/name/CLSID." },
    },
    result = { name = "weapons", type = "table", description = "{ weapons = { { clsid, display_name, name, category }, ... }, truncated }" },
  })

  local db_export_n = 0
  router:add_method("db_export", function(params)
    need_db()
    local what = (params and params.what) or "all"
    local value
    if what == "all" then
      value = db
    elseif what == "weapons" then
      value = db.Weapons
    elseif string.sub(what, 1, 9) == "category:" then
      local entry = get_cache().by_name[string.sub(what, 10)]
      if not entry then
        error("unknown category in '" .. what .. "' (see db_categories)", 0)
      end
      value = entry.array
    elseif string.sub(what, 1, 5) == "unit:" then
      local lower = string.lower(string.sub(what, 6))
      for _, entry in ipairs(get_cache().categories) do
        local hit = type_index(entry)[lower]
        if hit then
          value = hit
          break
        end
      end
      if not value then
        error("unknown unit type in '" .. what .. "' (see db_unit_types)", 0)
      end
    else
      error("db_export: `what` must be all | weapons | category:<name> | unit:<type>", 0)
    end

    -- RT.encode is cycle-safe (db is a deep graph with shared/cyclic tables);
    -- write via the guarded file writer so a tens-of-MB dump never rides the
    -- socket. Runs on the sim thread — `all` can stall for seconds.
    local json = RT.encode(value, true)
    db_export_n = db_export_n + 1
    local tag = string.gsub(what, "[^%w]+", "-")
    local rel = "Temp/dcs-studio-db-" .. tag .. "-" .. os.time() .. "-" .. db_export_n .. ".json"
    local ok, werr = bridge.file.write_text(rel, json)
    if not ok then
      error("cannot write export: " .. tostring(werr), 0)
    end
    local writedir = (type(lfs) == "table" and lfs.writedir and lfs.writedir()) or ""
    return { path = writedir .. string.gsub(rel, "/", "\\"), bytes = #json }
  end, {
    summary = "Dump part (or all) of the DCS database to a JSON file.",
    description = "Write pretty JSON to <writedir>Temp\\dcs-studio-db-*.json and return { path, bytes } — a file, not a response payload, so a tens-of-MB dump never rides the WebSocket. `what` = all (default) | weapons | category:<name> | unit:<type>. Runs on the sim thread; `all` may stall for seconds (the 30s server timeout is the backstop).",
    params = {
      { name = "what", type = "string", required = false, description = "all (default) | weapons | category:<name> | unit:<type>." },
    },
    result = { name = "export", type = "table", description = "{ path, bytes }" },
  })

  -- Self-heal the mission bridge: while a mission is running, re-dispatch the
  -- boot at most every 10s. The snippet is a no-op once booted, so this only
  -- matters when the first dispatch ran before the scripting state was ready.
  local function mission_boot_tick()
    local mt = (DCS.getModelTime and DCS.getModelTime()) or 0
    if mt > 0 and (os.clock() - boot_at) > 10 then
      dispatch_mission_boot()
    end
  end

  return {
    dispatch_mission_boot = dispatch_mission_boot,
    mission_boot_tick = mission_boot_tick,
  }
end
