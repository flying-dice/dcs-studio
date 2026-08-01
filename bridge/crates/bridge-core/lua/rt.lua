-- DCS Studio console/REPL runtime (installed as __DCS_STUDIO_RT). Embedded in
-- the bridge DLLs (include_str!) and installed into each DLL's own Lua state
-- by bootstrap(); the GUI hook also prepends this source to net.dostring_in
-- calls so remote states (server/config/export) self-install it — idempotent
-- via the version guard, so a fresh state heals itself on the next call. Pure
-- Lua 5.1 with no require. Entry points return JSON strings because
-- dostring_in can only pass strings between states.
if not (__DCS_STUDIO_RT and __DCS_STUDIO_RT.version == 3) then
  local RT = { version = 3, refs = {}, nrefs = 0 }
  local MAX_TABLE_CHILDREN = 1000 -- cap children returned for one expand
  -- Ref ceiling so a huge drill-down can't pin unbounded memory. Raised for v2:
  -- functions now consume refs too (single table slots each), and a budget-
  -- capped sweep can register ~200 fetches × up to 1000 children.
  local MAX_REFS = 500000
  local MAX_DEPTH = 200 -- encode recursion guard; deeper nests become "<max depth>"
  -- The debug library may be absent entirely (a sanitized or embedded state):
  -- degrade to plain "function" previews and an explicit signature error
  -- instead of indexing a nil global. pcall can't protect `debug.getinfo`
  -- itself when `debug` is nil — the index raises before the call starts.
  local dbg = type(debug) == "table" and debug or nil

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
  -- by tostring (raw tostring as the tiebreak). Mirrored INLINE by
  -- debug_engine.lua's D.expand comparator (see the dbg_preview lockstep note
  -- there); kept in sync by hand so the engine stays self-contained.
  local function key_order(a, b)
    local na, nb = type(a) == "number", type(b) == "number"
    if na ~= nb then return na end
    if na then return a < b end
    local sa, sb = tostring(a), tostring(b)
    local la, lb = string.lower(sa), string.lower(sb)
    if la ~= lb then return la < lb end
    return sa < sb
  end

  -- Indentation for one nesting level, memoised. A pretty encode needs the same
  -- two pads for every table at a given depth, and string.rep was rebuilding
  -- both of them per table — thousands of identical strings for one export of a
  -- wide sim table. Bounded by MAX_DEPTH, so the cache is at most 201 entries.
  local INDENT = {}
  local function indent(depth)
    local pad = INDENT[depth]
    if not pad then
      pad = string.rep("  ", depth)
      INDENT[depth] = pad
    end
    return pad
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
        pad = indent(depth + 1)
        pad0 = indent(depth)
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

  -- Single-line preview for the drill-down explorer. Deliberately MIRRORS (does
  -- not share) debug_engine.lua's dbg_preview: the two diverge on functions — the
  -- REPL explorer shows arity here, the debugger renders a bare "function" — and
  -- the engine stays self-contained (see the lockstep note there), so this copy
  -- is kept in sync by hand.
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
    elseif t == "function" then
      -- Arity preview from debug.getinfo ONLY — never call the function.
      -- Order matters: detect C functions first (they have no nparams even in
      -- Lua versions that provide it), then fall back when nparams is absent
      -- (PUC 5.1 / a sanitized debug lib gives only nups from "u").
      if not dbg or type(dbg.getinfo) ~= "function" then
        return "function"
      end
      local ok, info = pcall(dbg.getinfo, v, "uS")
      if not ok or type(info) ~= "table" then
        return "function"
      end
      if info.what == "C" then
        return "function (native)"
      end
      if info.nparams == nil then
        return "function"
      end
      if info.isvararg then
        if info.nparams == 0 then
          return "function (varargs)"
        end
        return "function (" .. info.nparams .. "+ args)"
      end
      return "function (" .. info.nparams .. " args)"
    elseif t == "userdata" or t == "thread" then
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

  -- A ref > 0 is handed out for anything the client can drill into: tables
  -- (expand) and functions (resolve signature). The client branches on `type`.
  local function ref_for(v)
    local t = type(v)
    if t == "table" or t == "function" then
      return register(v)
    end
    return 0
  end

  -- ── DCS control-API calls that kill the PROCESS (card 19) ──
  --
  -- `DCS.getMissionLoaded()` with a mission loaded takes DCS down on the spot:
  -- C0000005 ACCESS_VIOLATION in `lua_pushnil` under a runaway
  -- `ED_lua_copyindex` recursion (598 and 997 frames deep in the two dumps) —
  -- ED's cross-state value copy walking a graph it never terminates on. That is
  -- a hardware fault in a C recursion, not a Lua error: **no pcall can contain
  -- it** (measured live — `pcall(DCS.getMissionLoaded)` dies exactly like the
  -- bare call), and it is equally fatal through `net.dostring_in`, so the
  -- server/config/export environments offer no safe delegate either. The only
  -- defence is not to make the call. Verified on DCS 2.9.27.25340.
  --
  -- Measured SAFE in the same live session, with a mission loaded, and
  -- deliberately NOT listed here: getPause, getModelTime, getRealTime,
  -- getMissionName, getMissionFilename, getMissionDescription, getMissionTheatre,
  -- getMissionOptions, getMissionResult, getMissionPersistenceData,
  -- getCurrentMission, getUserOptions, getSimulatorMode, getAvailableCoalitions,
  -- getPlayerUnit, getPlayerUnitType, getPlayerCoalition, getUnitProperty,
  -- isMultiplayer, isServer. (The card's title also blamed `getPause`; it is
  -- innocent — it answers `true`/`false` at the menu and in a mission.)
  local FATAL_DCS = {
    getMissionLoaded = "DCS.getMissionLoaded() is blocked by DCS Studio: called with a mission loaded it "
      .. "crashes DCS 2.9.27 instantly (ACCESS_VIOLATION inside ED's cross-state value copy), and no pcall "
      .. "can contain it. Use DCS.getMissionName() (empty string at the main menu) or DCS.getModelTime() instead.",
  }

  -- The `DCS` table as user chunks see it: a snapshot of the real one with the
  -- fatal getters replaced by a stub that raises a truthful Lua error. The
  -- snapshot (rather than a bare `__index` proxy) keeps `for k, v in pairs(DCS)`
  -- working, since Lua 5.1's pairs ignores metamethods; `__index` still covers
  -- keys DCS adds later, and `__newindex` sends writes of NEW keys to the real
  -- table. Writes to keys present in the snapshot stay sandbox-local — which is
  -- the harmless direction, and it means a user cannot un-block a fatal getter
  -- for the rest of the process by assigning over it.
  --
  -- Not a sandbox: `getmetatable(DCS).__index` (or `debug.getregistry`, or
  -- `rawset` on `getfenv()`) reaches the real table, and that is fine. The
  -- threat model is the ACCIDENT — the console user, the extension, or a script
  -- typing a documented-looking getter — not an author determined to call
  -- something that crashes their own sim.
  local function guarded_dcs(real)
    local proxy = {}
    for k, v in pairs(real) do
      proxy[k] = v
    end
    for name, why in pairs(FATAL_DCS) do
      proxy[name] = function()
        error(why, 0)
      end
    end
    return setmetatable(proxy, { __index = real, __newindex = real })
  end

  -- The guarded view of the live `DCS`, memoized against its identity so a state
  -- that swaps the table gets a fresh snapshot. Anything that is not a table
  -- (nil in a mission state, or a value a chunk assigned) passes through
  -- untouched — there is nothing to guard and pretending otherwise would lie
  -- about what the name holds.
  local guard_for, guard_dcs

  local function guarded_dcs_for(real)
    if type(real) ~= "table" then
      return real
    end
    if guard_for ~= real then
      guard_for = real
      guard_dcs = guarded_dcs(real)
    end
    return guard_dcs
  end

  -- Environment for chunks the user asked us to run (console eval, inspect,
  -- export, the `eval` RPC). Everything but `DCS` reads and writes straight
  -- through to `_G`, so global side effects behave exactly as before the guard
  -- existed. nil in a state without a `DCS` table (every mission state), where
  -- the chunk runs in the plain global environment as it always did.
  --
  -- Built FRESH per chunk, and that is load-bearing (review of card 19). The
  -- table itself must stay empty — `__newindex` forwards, so nothing is ever
  -- stored in it — because a `DCS` key PRESENT in a shared env would be
  -- overwritten in place by a chunk's bare `DCS = x` without `__newindex` ever
  -- firing, and that overwrite would then disable the guard for every later
  -- eval/inspect/export/watch in the state. One accidental console line must not
  -- be able to do that. So `DCS` is served from `__index` (always the current
  -- guarded view) and a bare `DCS = x` is captured here instead: **sandbox-local
  -- to the one chunk that wrote it** — that chunk reads back its own value, the
  -- state's real `DCS` is left intact, and the next chunk gets the guard back.
  -- The expensive part (the ~230-key snapshot) is memoized above; this is one
  -- empty table and one metatable per chunk.
  local function chunk_env()
    if type(DCS) ~= "table" then
      return nil
    end
    local dcs_local, dcs_written = nil, false
    return setmetatable({}, {
      __index = function(_, k)
        if k == "DCS" then
          if dcs_written then
            return dcs_local
          end
          return guarded_dcs_for(_G.DCS)
        end
        return _G[k]
      end,
      __newindex = function(_, k, v)
        if k == "DCS" then
          dcs_local, dcs_written = v, true
          return
        end
        _G[k] = v
      end,
    })
  end

  -- The globals table a user-facing evaluation should resolve names through:
  -- the guarded environment where there is a `DCS` table, else plain `_G`. The
  -- debug engine's watch/hover/console evaluations chain their frame-locals
  -- proxy onto this rather than onto `_G` directly. A fresh table per call (see
  -- chunk_env), so callers hold ONE for the whole evaluation rather than asking
  -- per name lookup.
  function RT.global_env()
    return chunk_env() or _G
  end

  -- Run `f` (a freshly loaded chunk) in that environment. Exposed because
  -- gui_methods.lua's `eval` and the debug engine load their own chunks, and
  -- neither may be the one hole in the guard.
  function RT.guard_chunk(f)
    local env = chunk_env()
    if env then
      setfenv(f, env)
    end
    return f
  end

  local function compile(code)
    local f, err = loadstring("return " .. code)
    if not f then
      f, err = loadstring(code)
    end
    if f then
      return RT.guard_chunk(f), nil
    end
    return f, err
  end

  -- A `print` replacement shared by every co-installed state: stringify the
  -- varargs (tab-joined), feed the line to `sink`, then forward to `prev` (the
  -- real print). The gui/mission method chunks and the debug engine each install
  -- one with bridge.console.print as the sink so editor-driven runs stream their
  -- print-debugging into the IDE Console; capture_prints below uses it too, with
  -- a list-appending sink — ONE definition of the varargs→line shim for all four.
  function RT.print_shim(sink, prev)
    return function(...)
      local parts = {}
      for i = 1, select("#", ...) do
        parts[#parts + 1] = tostring(select(i, ...))
      end
      sink(table.concat(parts, "\t"))
      if prev then
        pcall(prev, ...)
      end
    end
  end

  -- Run `fn(...)` with `_G.print` swapped for a print_shim streaming each line to
  -- `sink` as well as the real print, restoring print on every path and
  -- re-raising a captured error at level 0. The gui/mission `eval` handlers share
  -- this; NOT used by debug_run — the engine swaps print around its own xpcall so
  -- on_error can snapshot the live crash frames before the stack unwinds.
  function RT.with_print_capture(sink, fn, ...)
    local prev = _G.print
    _G.print = RT.print_shim(sink, prev)
    local results = { pcall(fn, ...) }
    _G.print = prev
    if not results[1] then
      error(results[2], 0)
    end
    return unpack(results, 2)
  end

  -- Decode a JSON envelope produced by the RT.*_json entry points (via the DLL's
  -- json.decode, handed in — this pure-Lua runtime has no decoder), forward any
  -- `prints` it carries to `sink` (the console ring) and strip them, then return
  -- the table. A non-table means the state handed back a raw error string instead
  -- of an envelope; `label` names the source in that error message.
  function RT.decode_envelope(decode, sink, res, label)
    local tbl = decode(res)
    if type(tbl) ~= "table" then
      error(tostring(label) .. " returned: " .. string.sub(tostring(res), 1, 400), 0)
    end
    if type(tbl.prints) == "table" then
      for _, line in ipairs(tbl.prints) do
        sink(line)
      end
      tbl.prints = nil
    end
    return tbl
  end

  -- Run `fn` collecting print() output (restored on every path); each line also
  -- forwards to the environment's own print when it has one.
  local function capture_prints(fn)
    local prints = {}
    local prev = print
    print = RT.print_shim(function(line) prints[#prints + 1] = line end, prev)
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
    return RT.encode({ ok = true, type = type(res), value = preview(res), ref = ref_for(res) })
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
      out[#out + 1] = { name = tostring(k), type = type(val), value = preview(val), ref = ref_for(val) }
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

  -- Decode the prefix protocol export_json produces: "ERR:<msg>" raises at level
  -- 0, "OK:<json>" returns the json body, anything else is a malformed reply. The
  -- inverse of RT.export_json — kept beside its producer so the two stay in
  -- lockstep. The caller owns writing the body to a file.
  function RT.decode_export(res)
    if string.sub(res, 1, 4) == "ERR:" then
      error(string.sub(res, 5), 0)
    end
    if string.sub(res, 1, 3) ~= "OK:" then
      error("export failed: " .. string.sub(res, 1, 400), 0)
    end
    return string.sub(res, 4)
  end

  -- Resolve a function's real parameter names WITHOUT running its body — the
  -- fiddle "GET_ARGS" trick, hardened. The probe runs on a FRESH COROUTINE
  -- carrying a call hook: the hook fires the instant the body is entered
  -- (arguments already bound as the first locals), reads their names via
  -- debug.getlocal, and error()s out so the body never executes. { ok, params }
  -- | { ok, native } | { ok = false, err }.
  --
  -- The coroutine is the safety property, not a nicety — the same Lua 5.1 rule
  -- debug_engine.lua's call_bounded is built on: a hook never fires from inside
  -- a running hook. Probing on the CURRENT thread while the debug engine holds
  -- it (a pause pumps RPC from its line hook, and so does the run-loop drain)
  -- would skip the hook entirely and RUN the target function with no arguments
  -- — arbitrary DCS/mission side effects on the sim thread, reported back as
  -- "takes no parameters". A fresh coroutine has its own hook slot and starts
  -- with hooks enabled, so the probe is safe whoever is asking.
  function RT.signature_json(ref)
    local fn = RT.refs[ref or 0]
    if type(fn) ~= "function" then
      return RT.encode({ ok = false, err = "stale ref (state was reset?) - inspect again and retry" })
    end
    if not dbg or type(dbg.getinfo) ~= "function" or type(dbg.sethook) ~= "function"
      or type(dbg.gethook) ~= "function" or type(dbg.getlocal) ~= "function" then
      return RT.encode({ ok = false, err = "signature unavailable - debug library not present" })
    end
    if type(coroutine) ~= "table" or type(coroutine.create) ~= "function"
      or type(coroutine.resume) ~= "function" then
      return RT.encode({ ok = false, err = "signature unavailable - coroutine library not present" })
    end
    -- C functions FIRST: debug.getlocal on a C frame never terminates the
    -- capture loop, so bail before hooking anything.
    local okS, sinfo = pcall(dbg.getinfo, fn, "S")
    if okS and type(sinfo) == "table" and sinfo.what == "C" then
      return RT.encode({ ok = true, params = "", native = true })
    end
    local names = {}
    local co = coroutine.create(fn)
    dbg.sethook(co, function()
      -- Frame 1 is this hook; frame 2 is the just-entered callee. Ignore any
      -- frame that is not our target, so getlocal never runs against a C frame.
      local fi = dbg.getinfo(2, "f")
      if not fi or fi.func ~= fn then
        return
      end
      local i = 1
      while true do
        local name = dbg.getlocal(2, i)
        if name == nil or name == "(*temporary)" then
          break
        end
        names[i] = name
        i = i + 1
      end
      error("") -- abort before the body runs
    end, "c") -- call events only
    -- Confirm the hook really landed on the probe thread before resuming it: a
    -- debug library that ignored the thread argument would leave the coroutine
    -- unhooked, and the resume below would then run the body for real — the
    -- exact side effect this whole shape exists to prevent.
    if dbg.gethook(co) == nil then
      return RT.encode({ ok = false, err = "signature unavailable - the probe hook could not be installed" })
    end
    coroutine.resume(co)
    -- Lua 5.1 keeps per-thread hooks in a registry keyed by the thread, and a
    -- dead coroutine's entry is not collected with it; clearing drops it.
    dbg.sethook(co)
    return RT.encode({ ok = true, params = table.concat(names, ", ") })
  end

  __DCS_STUDIO_RT = RT
end
