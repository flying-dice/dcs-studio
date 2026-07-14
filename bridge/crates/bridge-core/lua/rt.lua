-- DCS Studio console/REPL runtime (installed as __DCS_STUDIO_RT). Embedded in
-- the bridge DLLs (include_str!) and installed into each DLL's own Lua state
-- by bootstrap(); the GUI hook also prepends this source to net.dostring_in
-- calls so remote states (server/config/export) self-install it — idempotent
-- via the version guard, so a fresh state heals itself on the next call. Pure
-- Lua 5.1 with no require. Entry points return JSON strings because
-- dostring_in can only pass strings between states.
if not (__DCS_STUDIO_RT and __DCS_STUDIO_RT.version == 2) then
  local RT = { version = 2, refs = {}, nrefs = 0 }
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

  -- Resolve a function's real parameter names WITHOUT running its body — the
  -- fiddle "GET_ARGS" trick, hardened. Install a call hook, then pcall the
  -- function: the hook fires the instant the body is entered (arguments already
  -- bound as the first locals), reads their names via debug.getlocal, and
  -- error()s out so the body never executes. { ok, params } | { ok, native } |
  -- { ok = false, err }.
  function RT.signature_json(ref)
    local fn = RT.refs[ref or 0]
    if type(fn) ~= "function" then
      return RT.encode({ ok = false, err = "stale ref (state was reset?) - inspect again and retry" })
    end
    if not dbg or type(dbg.getinfo) ~= "function" or type(dbg.sethook) ~= "function" or type(dbg.getlocal) ~= "function" then
      return RT.encode({ ok = false, err = "signature unavailable - debug library not present" })
    end
    -- C functions FIRST: debug.getlocal on a C frame never terminates the
    -- capture loop, so bail before hooking anything.
    local okS, sinfo = pcall(dbg.getinfo, fn, "S")
    if okS and type(sinfo) == "table" and sinfo.what == "C" then
      return RT.encode({ ok = true, params = "", native = true })
    end
    local names = {}
    -- Capture and restore whatever hook was installed (the debugger's, say) on
    -- every exit path.
    local prev_hook, prev_mask, prev_count = dbg.gethook()
    local function restore()
      if prev_hook then
        dbg.sethook(prev_hook, prev_mask or "", prev_count or 0)
      else
        dbg.sethook()
      end
    end
    local hook = function()
      -- Frame 1 is this hook; frame 2 is the just-entered callee. Ignore any
      -- frame that is not our target (e.g. pcall itself), so getlocal never
      -- runs against a C frame.
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
    end
    dbg.sethook(hook, "c") -- call events only
    pcall(fn)
    restore()
    return RT.encode({ ok = true, params = table.concat(names, ", ") })
  end

  __DCS_STUDIO_RT = RT
end
