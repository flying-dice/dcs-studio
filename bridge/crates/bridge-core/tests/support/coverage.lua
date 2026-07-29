-- Lua line coverage for the bridge's own chunks (#66). TEST-ONLY: loaded by the
-- Rust harness, never by the shipped DLL.
--
-- The problem this solves, measured rather than assumed: Lua 5.1 has exactly
-- ONE hook per thread. `debug_engine.lua` installs its own while a debug
-- session steps, and clears it with `debug.sethook()` when the session ends —
-- which does not restore ours, it removes it. A plain coverage hook therefore
-- stops measuring the moment the first debug test runs and never resumes,
-- reporting whatever it happened to see before that as if it were the whole
-- picture.
--
-- So `debug.sethook` is replaced by a multiplexer: coverage always runs, a
-- guest hook runs after it, and clearing removes only the guest.

local M = {}

-- [source][line] = count. `source` is the chunk name Lua reports, which for the
-- bridge's chunks is the `=dcs_studio_*` name set on the Rust side.
local hits = {}

local real_sethook = debug.sethook
local real_create = coroutine.create

--- Record one line event. Kept tiny: it runs on every line of every chunk.
---
--- `level` is the running code as seen from the HOOK, not from here. The hook
--- itself is level 1 and its caller — the code whose line just fired — is level
--- 2; reading it from inside a helper the hook calls would report this file
--- instead, which is exactly what the first attempt did.
local function record(level, line)
  local info = debug.getinfo(level, "S")
  local src = info and info.source or "?"
  local lines = hits[src]
  if not lines then
    lines = {}
    hits[src] = lines
  end
  lines[line] = (lines[line] or 0) + 1
end

-- The guest hook per thread, keyed by coroutine (main thread under `false`).
-- Each entry keeps the mask and count the guest ASKED for, not just the
-- function: `debug_engine.lua` bounds every evaluation with
-- `sethook(co, fn, "count", EVAL_CHECK_INSTRUCTIONS)`, and a shim that armed
-- plain "l" would silently disarm that budget — a runaway `while true do end`
-- would then never be cut off. Measured, not theorised: dropping the mask made
-- `a_runaway_evaluation_is_cut_off_and_the_pause_survives_it` fail.
local guests = setmetatable({}, { __mode = "k" })

local function thread_key(co)
  return co or false
end

--- Coverage first, then the guest — but only for the events it asked for.
local function multiplexed(event, line)
  if event == "line" then
    -- 3, not 2: this function is level 1, `record` would see itself at 2.
    record(3, line)
  end
  local g = guests[thread_key(coroutine.running())]
  if g and g.fn and string.find(g.events, event, 1, true) then
    -- Calling the guest puts it ONE FRAME DEEPER than the hook Lua invoked,
    -- which is why `arm` hands line-mask guests the thread outright. A proper
    -- tail call (`return g.fn(event, line)`) does not rescue it: measured on
    -- PUC 5.1.5, the guest's `debug.getinfo(2)` then reports the pseudo-frame
    -- `=(tail call)` with `currentline = -1`, which is worse than the +1.
    g.fn(event, line)
  end
end

--- The mask coverage needs ("l") unioned with the guest's, so neither loses an
--- event. The count is the guest's: coverage does not use count events, and a
--- non-zero count is what makes the engine's instruction budget fire at all.
local function combined(g)
  local mask = "l"
  if g and g.mask then
    for letter in string.gmatch(g.mask, "[crl]") do
      if letter ~= "l" then
        mask = mask .. letter
      end
    end
  end
  return mask, (g and g.count) or 0
end

--- Install the multiplexer on `co` (nil = the current thread).
---
--- A guest asking for COUNT events gets the thread to itself, and coverage
--- stands down on it. This is a real limit of Lua 5.1, not a shortcut: a hook
--- does not fire inside a hook, and a line hook runs on every line — so a
--- count hook sharing the thread is starved of the very events it exists for.
--- `debug_engine.lua`'s `call_bounded` bounds every watch, hover and
--- breakpoint condition that way, and multiplexing there disarmed the budget:
--- `while true do end` was awaited instead of cut off, holding the sim thread.
--- Measured, not reasoned about — it failed three safety tests in
--- `debug_engine_safety.rs`.
---
--- So those coroutines' lines are unmeasured, and that is the correct trade:
--- measurement must never disable the mechanism it is measuring.
---
--- EXPERIMENT TOGGLE (#66 comment 5083258905 §3). The paragraph above is the
--- prototype author's own note and #68 records it as unreliable: the
--- mask-dropping bug was fixed *by adding* `combined()`, and nobody can tell
--- whether the three-test failure predated that fix. Lua 5.1 accepts
--- `LUA_MASKLINE | LUA_MASKCOUNT` on a single `lua_sethook` and delivers
--- "line" or "count" to the same function, so there is no nesting to be
--- starved by. With `__COV_MULTIPLEX_COUNT` set, count-hooked threads go
--- through `combined()` like every other guest and the hand-over never
--- happens. Everything else, including this default, is verbatim.
---
--- TRAP 4, found by re-running this prototype (#66 / board card 05) and NOT in
--- the original writeup. A guest that asked for LINE events is handed the
--- thread too, and the reason is stack depth rather than starvation:
--- `multiplexed` CALLS the guest, so the guest runs one frame deeper than the
--- hook Lua invoked, and `debug_engine.lua:598` reads
--- `debug.getinfo(2, "nSlf")` to find the frame whose line just fired. One
--- extra frame makes that read this file instead, `should_pause` is then asked
--- about the wrong source, and BREAKPOINTS NEVER FIRE — which is what actually
--- failed three tests in `debug_engine_safety.rs`, in 0.2s, with "the
--- breakpoint really did hold a pause". It was written up as line
--- instrumentation being too slow for the sub-second budgets. It is not: with
--- this hand-over in place the whole suite passes fully instrumented, in the
--- same wall time as uninstrumented. This is trap #1 from the prototype's own
--- writeup — the `debug.getinfo` level — applied to the guest rather than to
--- `record`.
---
--- Set `__COV_MULTIPLEX_LINE_GUESTS` to reproduce the original failure.
local function arm(co)
  local key = thread_key(co or coroutine.running())
  local g = guests[key]
  if g and g.fn and not __COV_MULTIPLEX_LINE_GUESTS and string.find(g.mask or "", "l", 1, true) then
    if co then
      real_sethook(co, g.fn, g.mask, g.count)
    else
      real_sethook(g.fn, g.mask, g.count)
    end
    return
  end
  if g and (g.count or 0) > 0 and not __COV_MULTIPLEX_COUNT then
    -- The guest owns this thread. Re-install exactly what it asked for.
    if co then
      real_sethook(co, g.fn, g.mask, g.count)
    else
      real_sethook(g.fn, g.mask, g.count)
    end
    return
  end
  local mask, count = combined(g)
  if co then
    real_sethook(co, multiplexed, mask, count)
  else
    real_sethook(multiplexed, mask, count)
  end
end

--- Which Lua hook events a mask plus count actually produce.
local function events_for(mask, count)
  local events = ""
  if string.find(mask or "", "c", 1, true) then events = events .. "call " end
  if string.find(mask or "", "r", 1, true) then events = events .. "return " end
  if string.find(mask or "", "l", 1, true) then events = events .. "line " end
  if (count or 0) > 0 then events = events .. "count " end
  return events
end

local function remember(key, fn, mask, count)
  guests[key] = (type(fn) == "function")
      and { fn = fn, mask = mask or "", count = count or 0, events = events_for(mask, count) }
    or nil
end

--- `debug.sethook` as the engine sees it. Both 5.1 shapes are handled:
---   sethook(fn, mask [, count])        — this thread
---   sethook(co, fn, mask [, count])    — another thread
--- Clearing (`sethook()`) drops the guest and re-arms coverage, which is the
--- whole point: the engine's cleanup must not blind the measurement.
local function shimmed_sethook(a, b, c, d)
  if type(a) == "thread" then
    remember(thread_key(a), b, c, d)
    arm(a)
    return
  end
  remember(thread_key(coroutine.running()), a, b, c)
  arm(nil)
end

--- Report the guest, so engine code that reads back its own hook still works.
local function shimmed_gethook(co)
  local g = guests[thread_key(co or coroutine.running())]
  if g then
    return g.fn, g.mask, g.count
  end
  return nil
end

--- Coroutines start with no hook of their own, so `rt.lua`'s signature probe
--- and the engine's bounded evaluations would be invisible. Arm each one at
--- creation.
local function shimmed_create(fn)
  local co = real_create(fn)
  arm(co)
  return co
end

local function shimmed_wrap(fn)
  local co = shimmed_create(fn)
  return function(...)
    local out = { coroutine.resume(co, ...) }
    if not out[1] then
      error(out[2], 2)
    end
    return unpack(out, 2)
  end
end

--- Start measuring. Call before the bridge bootstraps, so the chunks it loads
--- are covered from their first line.
function M.install()
  debug.sethook = shimmed_sethook
  debug.gethook = shimmed_gethook
  coroutine.create = shimmed_create
  coroutine.wrap = shimmed_wrap
  arm(nil)
end

--- Everything seen so far, as `{ ["source"] = { [line] = count } }`.
function M.hits()
  return hits
end

--- Flat `source\tline\tcount` rows, for handing back to Rust without a JSON dep.
function M.report()
  local out = {}
  for src, lines in pairs(hits) do
    for line, count in pairs(lines) do
      out[#out + 1] = src .. "\t" .. line .. "\t" .. count
    end
  end
  table.sort(out)
  return table.concat(out, "\n")
end

return M
