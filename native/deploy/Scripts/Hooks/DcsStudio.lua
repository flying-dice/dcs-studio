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
  -- Server-side timeout well under the 300s default so a stalled editor
  -- request can never wedge the WS read loop for minutes, but long enough for
  -- console calls that serialize big tables on the sim thread (repl_export of
  -- the mission DB can take tens of seconds).
  local server = bridge.jsonrpc.JsonRpcServer.new({ host = "127.0.0.1", port = 25569, timeout = 30 })
  local router = bridge.jsonrpc.JsonRpcRouter.new()

  router:add_method("ping", function(params)
    return { pong = true, dcs_time = (DCS.getModelTime and DCS.getModelTime()) or 0 }
  end)

  -- Run arbitrary Lua in the GUI/hooks environment and return the result.
  -- localhost-only by the server bind; gives full DCS.*/net.* control
  -- (e.g. start missions, DCS.exitProcess()) for the editor and dev tooling.
  -- A `print` replacement that pipes into the DCS Studio console
  -- (dcs_studio.console) AS WELL AS the original sink, so editor-driven runs
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

  router:add_method("eval", function(params)
    local f, err = loadstring(params.code)
    if not f then
      error("loadstring: " .. tostring(err))
    end
    return with_print_capture(f)
  end)

  -- The IDE's console tail: lines printed since `after` (see console.read).
  router:add_method("console_read", function(params)
    return bridge.console.read(params and params.after or 0)
  end)

  -- Live type sync (issue #50). The DLL describes its own Lua surface and the
  -- live DCS API as `.d.lua` the editor's lua-analyzer indexes — emitted from
  -- inside the running sim, so hover/diagnostics match the EXACT loaded build,
  -- not an app-build snapshot. Both answer from boot (no mission required);
  -- dump_globals re-introspects `_G` per call, so it reflects whatever the sim
  -- currently exposes. Returned as { dlua = ... } per model TypeDefs.
  router:add_method("emit_dlua", function()
    return { dlua = bridge.emit_dlua() }
  end)

  router:add_method("dump_globals", function()
    return { dlua = bridge.dump_globals() }
  end)

  -- Console/REPL runtime, shared by every target environment. The same source
  -- runs locally in this hooks env AND is prepended to every net.dostring_in
  -- call so remote states (mission/server/config/export) self-install it —
  -- idempotent via the version guard, so a fresh state (DCS restart, new
  -- mission) heals itself on the next call. Pure Lua 5.1 with no require, so
  -- the SANITIZED mission scripting env can run it. Entry points return JSON
  -- strings because dostring_in can only pass strings between states.
  local RT_SOURCE = [==[
if not (__DCS_STUDIO_RT and __DCS_STUDIO_RT.version == 1) then
  local RT = { version = 1, refs = {}, nrefs = 0 }
  local MAX_TABLE_CHILDREN = 1000 -- cap children returned for one expand
  local MAX_REFS = 100000 -- ref ceiling so a huge drill-down can't pin unbounded memory
  local MAX_DEPTH = 200 -- encode recursion guard; deeper nests become "<max depth>"

  local function esc_str(s)
    s = string.gsub(s, "\\", "\\\\")
    s = string.gsub(s, '"', '\\"')
    s = string.gsub(s, "\r", "\\r")
    s = string.gsub(s, "\n", "\\n")
    s = string.gsub(s, "\t", "\\t")
    s = string.gsub(s, "%c", function(c)
      return string.format("\\u%04x", string.byte(c))
    end)
    return s
  end

  local function num_str(n)
    if n ~= n or n == math.huge or n == -math.huge then
      return "null" -- NaN/Inf are not JSON
    end
    if n == math.floor(n) and math.abs(n) < 1e15 then
      return string.format("%.0f", n)
    end
    return string.format("%.14g", n)
  end

  -- Contiguous 1..n integer keys means a JSON array; anything else an object.
  local function is_array(t)
    local n = 0
    for k in pairs(t) do
      if type(k) ~= "number" or k ~= math.floor(k) or k < 1 then
        return false, 0
      end
      n = n + 1
    end
    return n == #t, n
  end

  -- Stable key order: numeric keys ascending, then the rest case-insensitively
  -- by tostring (raw tostring as the tiebreak).
  local function key_order(a, b)
    local na, nb = type(a) == "number", type(b) == "number"
    if na ~= nb then return na end
    if na then return a < b end
    local sa, sb = tostring(a), tostring(b)
    local la, lb = string.lower(sa), string.lower(sb)
    if la ~= lb then return la < lb end
    return sa < sb
  end

  -- Cycle-safe JSON encoder (the DLL's json.* is unreachable from remote
  -- states, and the Rust serializer has no cycle guard anyway). `seen` marks
  -- tables on the CURRENT descent path only, so shared (DAG) tables still
  -- serialize everywhere they appear; a true cycle becomes "<cycle>".
  -- Functions/userdata/threads encode as their type name, matching how eval
  -- results have always rendered. Non-string keys go through tostring.
  local encode_to
  encode_to = function(parts, v, pretty, seen, depth)
    local t = type(v)
    if v == nil then
      parts[#parts + 1] = "null"
    elseif t == "boolean" then
      parts[#parts + 1] = v and "true" or "false"
    elseif t == "number" then
      parts[#parts + 1] = num_str(v)
    elseif t == "string" then
      parts[#parts + 1] = '"' .. esc_str(v) .. '"'
    elseif t == "table" then
      if seen[v] then
        parts[#parts + 1] = '"<cycle>"'
        return
      end
      if depth >= MAX_DEPTH then
        parts[#parts + 1] = '"<max depth>"'
        return
      end
      seen[v] = true
      local nl, pad, pad0 = "", "", ""
      if pretty then
        nl = "\n"
        pad = string.rep("  ", depth + 1)
        pad0 = string.rep("  ", depth)
      end
      local arr, n = is_array(v)
      if arr then
        if n == 0 then
          parts[#parts + 1] = "[]"
        else
          parts[#parts + 1] = "[" .. nl
          for i = 1, n do
            if i > 1 then parts[#parts + 1] = "," .. nl end
            parts[#parts + 1] = pad
            encode_to(parts, v[i], pretty, seen, depth + 1)
          end
          parts[#parts + 1] = nl .. pad0 .. "]"
        end
      else
        local keys = {}
        for k in pairs(v) do
          keys[#keys + 1] = k
        end
        table.sort(keys, key_order)
        parts[#parts + 1] = "{" .. nl
        for i = 1, #keys do
          if i > 1 then parts[#parts + 1] = "," .. nl end
          local k = keys[i]
          parts[#parts + 1] = pad .. '"' .. esc_str(tostring(k)) .. '":' .. (pretty and " " or "")
          encode_to(parts, v[k], pretty, seen, depth + 1)
        end
        parts[#parts + 1] = nl .. pad0 .. "}"
      end
      seen[v] = nil
    else
      parts[#parts + 1] = '"' .. t .. '"'
    end
  end

  function RT.encode(v, pretty)
    local parts = {}
    encode_to(parts, v, pretty and true or false, {}, 0)
    return table.concat(parts)
  end

  -- Single-line preview + lazy ref registration for the drill-down explorer
  -- (mirrors the debugger's dbg_preview/dbg_var).
  local function preview(v)
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

  local function register(v)
    if RT.nrefs >= MAX_REFS then return 0 end
    RT.nrefs = RT.nrefs + 1
    RT.refs[RT.nrefs] = v
    return RT.nrefs
  end

  local function compile(code)
    local f, err = loadstring("return " .. code)
    if not f then
      f, err = loadstring(code)
    end
    return f, err
  end

  -- Run `fn` collecting print() output (restored on every path); each line
  -- also forwards to the environment's own print when it has one.
  local function capture_prints(fn)
    local prints = {}
    local prev = print
    print = function(...)
      local parts = {}
      for i = 1, select("#", ...) do
        parts[#parts + 1] = tostring(select(i, ...))
      end
      prints[#prints + 1] = table.concat(parts, "\t")
      if prev then
        pcall(prev, ...)
      end
    end
    local ok, res = pcall(fn)
    print = prev
    return prints, ok, res
  end

  function RT.eval_json(code)
    local f, err = compile(code)
    if not f then
      return RT.encode({ ok = false, err = "loadstring: " .. tostring(err) })
    end
    local prints, ok, res = capture_prints(f)
    if not ok then
      return RT.encode({ ok = false, err = tostring(res), prints = prints })
    end
    return RT.encode({ ok = true, result = res, prints = prints })
  end

  function RT.inspect_json(expr)
    local f, err = compile(expr)
    if not f then
      return RT.encode({ ok = false, err = tostring(err) })
    end
    local ok, res = pcall(f)
    if not ok then
      return RT.encode({ ok = false, err = tostring(res) })
    end
    local ref = 0
    if type(res) == "table" then
      ref = register(res)
    end
    return RT.encode({ ok = true, type = type(res), value = preview(res), ref = ref })
  end

  function RT.expand_json(ref)
    local v = RT.refs[ref or 0]
    if type(v) ~= "table" then
      return RT.encode({ ok = true, variables = {} })
    end
    local keys, truncated = {}, false
    for k in pairs(v) do
      if #keys >= MAX_TABLE_CHILDREN then
        truncated = true
        break
      end
      keys[#keys + 1] = k
    end
    table.sort(keys, key_order)
    local out = {}
    for i = 1, #keys do
      local k = keys[i]
      local val = v[k]
      local cref = 0
      if type(val) == "table" then
        cref = register(val)
      end
      out[#out + 1] = { name = tostring(k), type = type(val), value = preview(val), ref = cref }
    end
    if truncated then
      out[#out + 1] = { name = "…", type = "string", value = "(truncated)", ref = 0 }
    end
    return RT.encode({ ok = true, variables = out })
  end

  function RT.clear_json()
    RT.refs = {}
    RT.nrefs = 0
    return RT.encode({ ok = true })
  end

  -- Full JSON of a value — by live ref (a drilled-into node) or by evaluating
  -- `expr` fresh. Prefix protocol instead of a JSON envelope so the
  -- (potentially huge) payload is never escaped a second time.
  function RT.export_json(expr, ref)
    local v
    if ref and ref > 0 then
      v = RT.refs[ref]
      if v == nil then
        return "ERR:stale ref (state was reset?) - inspect again and retry"
      end
    else
      local f, err = compile(expr or "")
      if not f then
        return "ERR:loadstring: " .. tostring(err)
      end
      local ok, res = pcall(f)
      if not ok then
        return "ERR:" .. tostring(res)
      end
      v = res
    end
    return "OK:" .. RT.encode(v, true)
  end

  __DCS_STUDIO_RT = RT
end
]==]

  -- Install the console runtime locally: "gui" targets this hooks env directly.
  assert(loadstring(RT_SOURCE))()

  -- Environments the console can target. "gui" runs here; server/config/export
  -- are DCS Lua states reached synchronously with net.dostring_in. "mission"
  -- (the real mission scripting env: coalition/world/trigger) can't be reached
  -- that way since DCS 2.9.27 — its dostring_in target became a trigger
  -- sandbox with a fire-and-forget a_do_script — so mission calls are
  -- forwarded to the resident mission runtime through the DLL mailbox.
  local REPL_ENVS = { gui = true, mission = true, server = true, config = true, export = true }

  local function repl_env(params)
    local envname = (params and params.env) or "gui"
    if not REPL_ENVS[envname] then
      error("unknown environment '" .. tostring(envname) .. "'", 0)
    end
    return envname
  end

  -- Run `__DCS_STUDIO_RT.<callexpr>` in `envname` and return its JSON string.
  -- Remote calls prepend RT_SOURCE so a fresh state self-installs the runtime
  -- before answering; refs handed out by inspect/expand live INSIDE that state
  -- and stay valid until repl_clear or the state is torn down. The MISSION
  -- environment is NOT served here: DCS 2.9.27 pointed dostring_in("mission")
  -- at a trigger sandbox whose a_do_script is fire-and-forget (no return
  -- value), so mission work is forwarded to the resident mission runtime
  -- through the DLL mailbox instead (rt_forward below).
  local function rt_call(envname, callexpr)
    if envname == "gui" then
      local f = assert(loadstring("return __DCS_STUDIO_RT." .. callexpr))
      return f()
    end
    local src = RT_SOURCE .. "\nreturn __DCS_STUDIO_RT." .. callexpr
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

  -- ── Mission forwarding (DCS ≥ 2.9.27) ──
  -- The real mission scripting state is reachable only through a deferred,
  -- valueless a_do_script, so a resident runtime (bootstrapped into the
  -- mission at onSimulationStart, dcs-fiddle style) executes mission work and
  -- passes results back through the DLL's process-wide mailbox. Handlers
  -- answer { pending = true, token } immediately; the client polls repl_poll.
  local MISSION_BOOT_FILE = lfs.writedir() .. "Scripts\\DcsStudioMission.lua"
  local mission_boot_at = 0 -- last bootstrap dispatch (os.clock); rate-limits self-heal

  local function dispatch_mission_boot()
    mission_boot_at = os.clock()
    local boot = string.format("dofile(%q)", MISSION_BOOT_FILE)
    -- Fire-and-forget into the real mission state via the trigger sandbox's
    -- a_do_script; the runtime announces itself by setting mission_ready.
    -- On ≤ 2.9.26 the same call simply runs synchronously.
    pcall(net.dostring_in, "mission", string.format("a_do_script(%q)", boot))
  end

  local function mission_available()
    if bridge.debug.mission_ready() then
      return true
    end
    -- Self-heal: a mission is up but the runtime isn't (hook deployed
    -- mid-session, boot file missing at mission start…) — re-dispatch the
    -- bootstrap, at most once every 5s.
    local mt = (DCS.getModelTime and DCS.getModelTime()) or 0
    if mt > 0 and (os.clock() - mission_boot_at) > 5 then
      dispatch_mission_boot()
    end
    return false
  end

  local MISSION_UNAVAILABLE = "the mission runtime is not available — is a mission running (and unpaused)? "
    .. "It boots a moment after mission start and needs a desanitized MissionScripting.lua "
    .. "(command: DCS Studio: Desanitize MissionScripting.lua); if the mission just started, retry in a few seconds."

  -- One job in flight at a time: the mailbox is a single slot per key, so a
  -- second post before the mission takes the first would clobber it.
  local outbox = { queue = {}, inflight = nil, inflight_at = 0 }

  local function outbox_pump()
    if outbox.inflight and (os.clock() - outbox.inflight_at) > 10 then
      -- The mission either took the job long ago or died; don't jam forever.
      outbox.inflight = nil
    end
    if outbox.inflight or #outbox.queue == 0 then
      return
    end
    local job = table.remove(outbox.queue, 1)
    outbox.inflight = job.token
    outbox.inflight_at = os.clock()
    bridge.debug.post_box("to_mission", bridge.json.safe_encode(job))
  end

  local function outbox_push(job)
    outbox.queue[#outbox.queue + 1] = job
    outbox_pump()
  end

  local function outbox_settle(token)
    if outbox.inflight == token then
      outbox.inflight = nil
    end
    outbox_pump()
  end

  local rt_token = 0
  local pending_rt = {} -- token → "envelope" | "export" while a job is outstanding

  local function rt_forward(callexpr, kind)
    if not mission_available() then
      error(MISSION_UNAVAILABLE, 0)
    end
    rt_token = rt_token + 1
    pending_rt[rt_token] = kind or "envelope"
    outbox_push({ token = rt_token, kind = "rt", callexpr = callexpr })
    return { pending = true, token = rt_token }
  end

  -- GUI-side mirror of a forwarded mission debug session (debug_run below).
  local mission_run = { pending = false, acked = false, deadline = 0 }

  -- Env-aware console (the Lua Console panel). repl_eval runs code in the
  -- chosen environment and returns { ok, result?, err? }; repl_inspect /
  -- repl_expand / repl_clear are the lazy table explorer; repl_export writes
  -- the full JSON of a value to a temp file and returns its path — a file, not
  -- a response payload, so a mission-DB-sized export never rides the WebSocket.
  local function rt_dispatch(envname, callexpr)
    if envname == "mission" then
      return rt_forward(callexpr)
    end
    return rt_envelope(envname, callexpr)
  end

  router:add_method("repl_eval", function(params)
    local envname = repl_env(params)
    return rt_dispatch(envname, string.format("eval_json(%q)", (params and params.code) or ""))
  end)

  router:add_method("repl_inspect", function(params)
    local envname = repl_env(params)
    return rt_dispatch(envname, string.format("inspect_json(%q)", (params and params.expr) or ""))
  end)

  router:add_method("repl_expand", function(params)
    local envname = repl_env(params)
    return rt_dispatch(envname, string.format("expand_json(%d)", (params and params.ref) or 0))
  end)

  router:add_method("repl_clear", function(params)
    return rt_dispatch(repl_env(params), "clear_json()")
  end)

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
    if envname == "mission" then
      return rt_forward(callexpr, "export")
    end
    return finalize_export(rt_call(envname, callexpr))
  end)

  -- Poll a forwarded mission job: { pending = true } until the resident
  -- runtime posts the result (needs the sim to tick — a paused sim stalls it).
  router:add_method("repl_poll", function(params)
    local token = params and params.token
    local kind = token and pending_rt[token]
    if not kind then
      error("unknown or already-collected repl token", 0)
    end
    local raw = bridge.debug.take_box("from_mission:" .. tostring(token))
    if raw == nil then
      return { pending = true }
    end
    pending_rt[token] = nil
    outbox_settle(token)
    if kind == "export" then
      return finalize_export(raw)
    end
    return decode_envelope("mission", raw)
  end)

  -- Debugger (model/dcs/debug.pds). ONE engine, embedded below as
  -- DEBUG_ENGINE_SOURCE and installed into whichever Lua state a session
  -- targets: executed at startup right here for "gui" sessions, and prepended
  -- to the mission dispatch (net.dostring_in → a_do_script) so the mission
  -- scripting sandbox self-installs it for "mission" sessions — the same
  -- self-healing pattern as RT_SOURCE. The Rust DLL holds the breakpoint
  -- registry and the pause/resume/stop flags as PROCESS-WIDE statics, so both
  -- states share one debugger brain; bridge.jsonrpc.process_queue lets the
  -- paused state drain the editor's RPCs itself while its frozen chunk holds
  -- the sim thread (this hook's onSimulationFrame cannot run then — that is
  -- exactly why mission debugging needs its own in-state pump).
  --
  -- The engine runs a chunk under a line hook SCOPED to that chunk's xpcall —
  -- never a global hook over DCS's own code. On a line carrying a breakpoint
  -- (or the next qualifying line of a pending step) it snapshots the full call
  -- stack, then pumps the RPC queue so the editor can inspect / resume / step
  -- while the world is frozen. The pause is held as long as the editor keeps
  -- polling (debug_state refreshes a liveness timestamp); only after 30s with
  -- NO client activity — a vanished editor — does it auto-continue, so a held
  -- breakpoint never freezes the sim forever. In Lua 5.1 the hook is disabled
  -- while it runs, so the pump's own lines never re-trigger it.
  local DEBUG_ENGINE_SOURCE = [==[
-- DCS Studio debug engine (installed as __DCS_STUDIO_DBG). Pure Lua 5.1 plus
-- the dcs_studio DLL, which it requires into THIS state: the mission sandbox
-- can only do that after MissionScripting.lua is desanitized (require/package
-- restored) — the guards below turn a locked-down state into a clear error
-- instead of a mystery.

local function __dbg_jerr(msg)
  msg = tostring(msg):gsub("\\", "\\\\"):gsub('"', '\\"'):gsub("%c", " ")
  return '{"ran":false,"error":"' .. msg .. '"}'
end

if type(debug) ~= "table" or type(debug.sethook) ~= "function"
  or type(debug.getinfo) ~= "function" or type(debug.getlocal) ~= "function" then
  return __dbg_jerr("the debug library is not available in this Lua state — breakpoints cannot work here")
end
if type(require) ~= "function" or type(package) ~= "table" then
  return __dbg_jerr("this environment is sanitized (require/package are nil). Run 'DCS Studio: Desanitize MissionScripting.lua', restart DCS, then start the mission and try again.")
end

if not (__DCS_STUDIO_DBG and __DCS_STUDIO_DBG.version == 1) then
  if not package.loaded["dcs_studio"] and type(lfs) == "table" and type(lfs.writedir) == "function" then
    package.cpath = package.cpath .. ";" .. lfs.writedir() .. "Mods\\tech\\DcsStudio\\bin\\?.dll"
  end
  local okmod, bridge = pcall(require, "dcs_studio")
  if not okmod then
    return __dbg_jerr("cannot load dcs_studio.dll in this Lua state: " .. tostring(bridge))
  end

  local DEBUG_IDLE_SECONDS = 30 -- auto-continue after this long with no client polling
  local DRAIN_INTERVAL_SECONDS = 0.05 -- max sim stall between RPC drains during a run
  local MAX_TABLE_CHILDREN = 1000 -- cap children returned/previewed for one table
  local MAX_REFS = 100000 -- per-pause ref ceiling so a cyclic/huge tree can't pin unbounded memory

  -- Refs above this are inspection refs (the persistent object-explorer
  -- registry); below it are per-pause snapshot refs. expand() routes by it.
  local INSPECT_BASE = 2000000000

  -- os.clock (CPU time) keeps ticking while a chunk holds the sim thread;
  -- timer.getTime (model time) does NOT, so under that fallback the throttled
  -- in-run drain and the idle auto-continue degrade (breakpoints still work).
  -- Desanitizing restores os, so the mission state normally has os.clock.
  local clock = (type(os) == "table" and os.clock)
    or (type(timer) == "table" and timer.getTime)
    or function() return 0 end

  local D = { version = 1, running = false, error = nil }
  D.pump = function() end -- the installer wires the env-specific RPC drain

  -- Two handle registries, both mapping ref → captured value/scope and inspected
  -- lazily via expand(). `vars` is the PER-PAUSE registry (snapshot fills it,
  -- cleared on resume). `inspect` is the PERSISTENT object-explorer registry
  -- (inspect() fills it; survives across calls until inspect_clear()).
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

  -- A `print` replacement that pipes into the DCS Studio console ring (shared
  -- Rust statics, so mission prints stream to the IDE exactly like hook-state
  -- prints) AS WELL AS the original sink.
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

  -- The editor's poll: paused/running/error + the pause snapshot. Also the
  -- liveness signal that keeps a held pause alive.
  function D.state()
    dbg.last_ping = clock()
    local snap = bridge.debug.paused()
    if snap == nil then
      return { paused = false, running = D.running or false, error = D.error }
    end
    return { paused = true, running = true, snapshot = snap }
  end

  -- Lazily expand a variable/scope ref: a scope yields its variables; a table
  -- value yields its children (each with its own ref if itself expandable). The
  -- ref routes by range to the per-pause registry or the persistent inspection
  -- registry, and children land in the same one as their parent.
  function D.expand(ref)
    ref = ref or 0
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
      -- Collect up to the cap, then SORT for a stable, readable order (pairs()
      -- is hash order): numeric keys ascending first (so arrays stay 1,2,3),
      -- then string keys alphabetically.
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
        table.insert(out, dbg_var(tostring(k), d.value[k], register))
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

  -- Evaluate `expr` against this state's live global environment and register
  -- the result for lazy exploration — the interactive object explorer, no pause
  -- or breakpoint needed. The ref survives across calls until inspect_clear().
  function D.inspect(expr)
    expr = expr or ""
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
  end

  -- Drop every inspection ref, releasing the held values.
  function D.inspect_clear()
    dbg.inspect = {}
    dbg.inspect_n = 0
    return { ok = true }
  end

  -- Replace the breakpoints for one source: { source, breakpoints = { { line,
  -- condition? }, ... } }. The registry and the per-line conditions live in the
  -- DLL's process-wide statics, so it does not matter which state serves this.
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
    -- wrapping pcall — on_error must snapshot the crash frames live).
    local prev_print = _G.print
    _G.print = console_print_shim(prev_print)
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

  -- Mission-state entry point: the GameGUI hook dispatches a mission debug_run
  -- through a_do_script as `<this engine source> return
  -- __DCS_STUDIO_DBG.mission_serve(code, source, pause_on_error)`. Builds this
  -- state's OWN router (the requests it can answer while it holds the sim
  -- thread) and pumps the DLL's process-wide queue with it. Returns the run
  -- result as a JSON string — a_do_script can only pass strings back out.
  function D.mission_serve(code, source, pause_on_error)
    local router = bridge.jsonrpc.JsonRpcRouter.new()
    router:add_method("ping", function()
      return { pong = true, dcs_time = (type(timer) == "table" and timer.getTime and timer.getTime()) or 0 }
    end)
    router:add_method("console_read", function(params)
      return bridge.console.read((params and params.after) or 0)
    end)
    router:add_method("debug_state", function()
      return D.state()
    end)
    router:add_method("debug_continue", function(params)
      local mode = (params and params.mode) or "continue"
      bridge.debug.request_resume(mode)
      return { ok = true, mode = mode }
    end)
    router:add_method("debug_pause", function()
      bridge.debug.request_pause()
      return { ok = true }
    end)
    router:add_method("debug_stop", function()
      bridge.debug.request_stop()
      bridge.debug.request_resume("continue")
      return { ok = true }
    end)
    router:add_method("debug_expand", function(params)
      return D.expand((params and params.ref) or 0)
    end)
    router:add_method("debug_eval", function(params)
      return D.eval((params and params.frame) or 0, (params and params.expr) or "")
    end)
    router:add_method("debug_set_breakpoints", function(params)
      return D.set_breakpoints(params)
    end)
    router:add_method("debug_clear_breakpoints", function()
      return D.clear_breakpoints()
    end)
    D.pump = function()
      bridge.jsonrpc.process_queue(router)
    end
    local res = D.run(code, source, pause_on_error)
    return bridge.json.safe_encode(res)
  end

  __DCS_STUDIO_DBG = D
end
]==]

  -- Install the debug engine locally: "gui" debug sessions run right here,
  -- pumping this server's queue through the hook's own router while paused.
  assert(loadstring(DEBUG_ENGINE_SOURCE, "=dcs_studio_debug_engine"))()
  local DBG = assert(__DCS_STUDIO_DBG, "debug engine failed to install in the hooks state")
  DBG.pump = function()
    server:process_rpc(router)
  end

  -- ── Resident mission runtime bootstrap (dcs-fiddle pattern) ──
  -- Written to <writedir>Scripts\DcsStudioMission.lua at startup and dofile'd
  -- into the real mission scripting state via a_do_script at each mission
  -- start. It loads the DLL (process-wide statics), installs the RT + debug
  -- engine permanently, and pumps forwarded jobs every 0.1s of model time.
  local MISSION_BOOT_HEADER = [==[
-- DCS Studio mission-side bootstrap. GENERATED by the DcsStudio GameGUI hook
-- at DCS startup — do not edit; the source of truth is Scripts\Hooks\DcsStudio.lua.
if __DCS_STUDIO_MISSION_BOOTED then
  return
end
local function __boot_fail(msg)
  if env and env.error then
    env.error("DCS Studio: " .. msg, true)
  end
end
if type(require) ~= "function" or type(package) ~= "table" then
  __boot_fail("mission scripting is sanitized (require/package are nil). Run 'DCS Studio: Desanitize MissionScripting.lua', restart DCS, then restart the mission.")
  return
end
if type(debug) ~= "table" or type(debug.sethook) ~= "function" then
  __boot_fail("the debug library is not available in the mission state - breakpoints cannot work.")
  return
end
if not package.loaded["dcs_studio"] and type(lfs) == "table" and type(lfs.writedir) == "function" then
  package.cpath = package.cpath .. ";" .. lfs.writedir() .. "Mods\\tech\\DcsStudio\\bin\\?.dll"
end
local __dll_ok, __dll_err = pcall(require, "dcs_studio")
if not __dll_ok then
  __boot_fail("cannot load dcs_studio.dll in the mission state: " .. tostring(__dll_err))
  return
end
__DCS_STUDIO_MISSION_BOOTED = true
]==]

  local MISSION_BOOT_PUMP = [==[
do
  local bridge = package.loaded["dcs_studio"]
  local D = __DCS_STUDIO_DBG
  if not (bridge and D and __DCS_STUDIO_RT) then
    if env and env.error then
      env.error("DCS Studio: mission runtime failed to install (engine or runtime missing) - check dcs.log.", true)
    end
    return
  end
  -- Forwarded-job pump: every 0.1s of model time take one job posted by the
  -- GameGUI hook, execute it HERE (the real mission scripting state), and
  -- post the result back through the DLL mailbox. A debug_run blocks this
  -- scheduled call for the whole session; the engine serves the editor
  -- itself while it runs (mission_serve wires D.pump to the shared queue).
  timer.scheduleFunction(function()
    bridge.debug.set_mission_ready(true)
    local ok, err = pcall(function()
      local raw = bridge.debug.take_box("to_mission")
      if not raw then
        return
      end
      local job = bridge.json.decode(raw)
      if type(job) ~= "table" then
        return
      end
      if job.kind == "rt" then
        local okc, res = pcall(function()
          local f = assert(loadstring("return __DCS_STUDIO_RT." .. job.callexpr))
          return f()
        end)
        if not okc then
          res = bridge.json.safe_encode({ ok = false, err = tostring(res) })
        end
        bridge.debug.post_box("from_mission:" .. tostring(job.token), tostring(res))
      elseif job.kind == "debug_run" then
        -- Ack BEFORE the run: the GUI clears its dispatch deadline on it (the
        -- run itself can block for minutes at a breakpoint).
        bridge.debug.post_box("from_mission:debug_run_ack", "1")
        local res = D.mission_serve(job.code or "", job.source or "=debug", job.pause_on_error == true)
        bridge.debug.post_box("from_mission:debug_run", tostring(res))
      end
    end)
    if not ok and env and env.info then
      env.info("DCS Studio mission pump error: " .. tostring(err))
    end
    return timer.getTime() + 0.1
  end, nil, timer.getTime() + 0.1)
  bridge.debug.set_mission_ready(true)
  env.info("DCS Studio mission runtime ready")
end
]==]

  local function write_mission_boot()
    local fh, ferr = io.open(MISSION_BOOT_FILE, "wb")
    if not fh then
      log.write("DCS-STUDIO", log.ERROR, "cannot write " .. MISSION_BOOT_FILE .. ": " .. tostring(ferr))
      return false
    end
    fh:write(MISSION_BOOT_HEADER, "\n", RT_SOURCE, "\n", DEBUG_ENGINE_SOURCE, "\n", MISSION_BOOT_PUMP)
    fh:close()
    return true
  end
  write_mission_boot()

  -- Run a chunk under the debugger. `env` picks the Lua state: "gui" (default)
  -- runs here in the hooks env; "mission" forwards code + chunkname to the
  -- resident mission runtime through the DLL mailbox (a_do_script cannot
  -- return values on DCS ≥ 2.9.27). The runtime acks on pickup, blocks the
  -- sim thread for the whole session serving the editor itself, and posts the
  -- run result back; onSimulationFrame below collects it. The editor must not
  -- await this call as an end signal: it polls debug_state instead, which
  -- mirrors `running` from mission_run until the engine takes over.
  router:add_method("debug_run", function(params)
    local envname = (params and params.env) or "gui"
    local code = (params and params.code) or ""
    local source = (params and params.source) or "=debug"
    local pause_on_error = params and params.pause_on_error == true
    if envname == "gui" then
      return DBG.run(code, source, pause_on_error)
    end
    if envname ~= "mission" then
      error("unknown debug environment '" .. tostring(envname) .. "'", 0)
    end
    if DBG.running or bridge.debug.paused() ~= nil or mission_run.pending then
      return { ran = false, error = "a debug session is already running" }
    end
    if not mission_available() then
      return { ran = false, error = MISSION_UNAVAILABLE }
    end
    bridge.debug.take_box("from_mission:debug_run") -- drain a stale result
    bridge.debug.take_box("from_mission:debug_run_ack")
    mission_run.pending = true
    mission_run.acked = false
    mission_run.deadline = os.clock() + 15
    DBG.error = nil
    outbox_push({
      token = "debug_run",
      kind = "debug_run",
      code = code,
      source = source,
      pause_on_error = pause_on_error,
    })
    return { dispatched = true }
  end)

  -- While a MISSION session is live (running or paused), every one of these is
  -- answered by the mission state's own router (mission_serve) — the sim
  -- thread is inside the run and this hook cannot pump then. They are served
  -- here for "gui" sessions, whenever nothing is being debugged, and in the
  -- short dispatch window before the mission runtime picks a run up (where
  -- `running` is mirrored from mission_run so the editor never sees a
  -- not-yet-started session as terminated).
  router:add_method("debug_state", function()
    local st = DBG.state()
    if mission_run.pending then
      st.running = true
    end
    return st
  end)

  router:add_method("debug_expand", function(params)
    return DBG.expand((params and params.ref) or 0)
  end)

  router:add_method("debug_eval", function(params)
    return DBG.eval((params and params.frame) or 0, (params and params.expr) or "")
  end)

  router:add_method("debug_inspect", function(params)
    return DBG.inspect((params and params.expr) or "")
  end)

  router:add_method("debug_inspect_clear", function()
    return DBG.inspect_clear()
  end)

  -- Replace one source's breakpoints (+ per-line conditions): the registry is
  -- process-wide in the DLL, so it works before AND during a session, whichever
  -- state is pumping.
  router:add_method("debug_set_breakpoints", function(params)
    return DBG.set_breakpoints(params)
  end)

  router:add_method("debug_clear_breakpoints", function()
    return DBG.clear_breakpoints()
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

  local cb = {}
  function cb.onSimulationFrame()
    -- While a forwarded mission session is live (acked, no result yet) the
    -- mission engine owns the shared queue — don't compete for requests here
    -- (on single-threaded builds this frame never fires then anyway).
    if not (mission_run.pending and mission_run.acked) then
      server:process_rpc(router) -- drains queued WS requests (fires at the menu too)
    end
    outbox_pump()
    if mission_run.pending then
      if not mission_run.acked and bridge.debug.take_box("from_mission:debug_run_ack") then
        mission_run.acked = true
        outbox_settle("debug_run")
      end
      local raw = bridge.debug.take_box("from_mission:debug_run")
      if raw then
        mission_run.pending = false
        outbox_settle("debug_run")
        local tbl = bridge.json.decode(raw)
        if type(tbl) == "table" and tbl.ran == false and tbl.error ~= nil then
          DBG.error = tostring(tbl.error)
        else
          DBG.error = nil
        end
      elseif not mission_run.acked and os.clock() > mission_run.deadline then
        mission_run.pending = false
        outbox_settle("debug_run")
        DBG.error = "the mission runtime did not pick the run up in time — is the sim unpaused? "
          .. "(the mission pump runs on model time; a paused sim cannot start a run)"
      end
    end
  end

  function cb.onSimulationStart()
    bridge.debug.set_mission_ready(false)
    write_mission_boot() -- refresh in case the hook was updated since boot
    dispatch_mission_boot()
  end

  function cb.onSimulationStop()
    bridge.debug.set_mission_ready(false)
    mission_run.pending = false
    mission_run.acked = false
    outbox.queue = {}
    outbox.inflight = nil
    bridge.debug.take_box("to_mission")
    bridge.debug.take_box("from_mission:debug_run")
    bridge.debug.take_box("from_mission:debug_run_ack")
  end
  DCS.setUserCallbacks(cb)

  log.write("DCS-STUDIO", log.INFO, "dcs_studio serving JSON-RPC on 127.0.0.1:25569")
end)
if not started then
  log.write("DCS-STUDIO", log.ERROR, "startup failed: " .. tostring(err))
end
