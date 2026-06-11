-- dcs-lua-runner prelude (model: studio::cli::TestRunner).
--
-- Loaded into a FRESH Lua 5.1 state before every test file: the
-- describe/test/expect harness plus the recording DCS stubs. Returns
-- { finalize = fn } for the Rust host to collect results.
--
-- Harness surface:
--   describe(name, fn)        groups (nestable; names join with " > ")
--   test(name, fn)            one case; failures record message + line
--   expect(v).toBe(x)         raw equality (==)
--   expect(v).toEqual(x)      deep table equality
--   expect(v).toBeTruthy()    not (false or nil)
--   expect(v).toBeFalsy()     false or nil
--   expect(v).toBeNil()       == nil
--   expect(v).toContain(x)    string substring (plain) or array member
--   expect(f).toThrow(s?)     f() must error; s = plain substring of it
--
-- DCS stub surface (every call is recorded into dcs.calls as
-- { fn = "timer.scheduleFunction", args = { ... } }, in call order):
--   timer.getTime / scheduleFunction / removeFunction
--   trigger.action.outText
--   env.info / env.warning / env.error
--   world.addEventHandler / world.removeEventHandler
--   runner.advanceTime(n)     manual clock: fires due scheduled functions
--                             in deadline order, same deadline FIFO; a
--                             fired function scheduling inside the window
--                             fires within the same advance; returning a
--                             number reschedules at that model time (DCS
--                             semantics)
--
-- Reading an unstubbed member of a stubbed table, or a known DCS global
-- with no stub at all, errors with "not stubbed yet: <name>" — a silent
-- nil must never let a test pass against an API the stubs cannot vouch
-- for. Non-DCS unknown globals keep normal Lua nil semantics.

local results = {}
local describe_stack = {}

-- ----------------------------------------------------------------- utils

local function repr(value)
  if type(value) == "string" then
    return string.format("%q", value)
  end
  return tostring(value)
end

local function deep_equal(a, b)
  if a == b then
    return true
  end
  if type(a) ~= "table" or type(b) ~= "table" then
    return false
  end
  for k, v in pairs(a) do
    if not deep_equal(v, b[k]) then
      return false
    end
  end
  for k in pairs(b) do
    if a[k] == nil then
      return false
    end
  end
  return true
end

-- Raise a matcher failure at the test body's line: level 1 is fail
-- itself, 2 the matcher closure, 3 the caller of the matcher.
local function fail(message)
  error(message, 3)
end

-- "path:line: message" (also "[string \"...\"]:line: message") out of an
-- error value; anything unprefixed keeps line 0 and the whole text.
local function parse_error(text)
  local line, message = string.match(text, "^.-:(%d+): (.*)$")
  if line then
    return message, tonumber(line)
  end
  return text, 0
end

-- xpcall handler: keep the text and a traceback so a failure inside a
-- helper function still yields a usable line. Defensive about debug
-- being absent so the handler itself can never become the error.
local traceback = (debug and debug.traceback) or function(message)
  return message
end

local function on_error(err)
  return { text = tostring(err), traceback = traceback(tostring(err), 2) }
end

local function failure_fields(err)
  local message, line = parse_error(err.text)
  if line == 0 then
    local traceback_line = string.match(err.traceback or "", ":(%d+):")
    line = tonumber(traceback_line) or 0
  end
  return message, line
end

-- -------------------------------------------------------------- matchers

function expect(value)
  local m = {}
  function m.toBe(expected)
    if value ~= expected then
      fail("expected " .. repr(value) .. " to be " .. repr(expected))
    end
  end
  function m.toEqual(expected)
    if not deep_equal(value, expected) then
      fail("expected " .. repr(value) .. " to deep-equal " .. repr(expected))
    end
  end
  function m.toBeTruthy()
    if not value then
      fail("expected " .. repr(value) .. " to be truthy")
    end
  end
  function m.toBeFalsy()
    if value then
      fail("expected " .. repr(value) .. " to be falsy")
    end
  end
  function m.toBeNil()
    if value ~= nil then
      fail("expected " .. repr(value) .. " to be nil")
    end
  end
  function m.toContain(needle)
    if type(value) == "string" then
      if not string.find(value, needle, 1, true) then
        fail("expected " .. repr(value) .. " to contain " .. repr(needle))
      end
      return
    end
    if type(value) == "table" then
      for _, item in ipairs(value) do
        if item == needle then
          return
        end
      end
      fail("expected the table to contain " .. repr(needle))
    end
    fail("toContain needs a string or a table, got " .. type(value))
  end
  function m.toThrow(pattern)
    if type(value) ~= "function" then
      fail("toThrow needs a function, got " .. type(value))
    end
    local ok, err = pcall(value)
    if ok then
      fail("expected the function to throw")
    end
    if pattern ~= nil and not string.find(tostring(err), pattern, 1, true) then
      fail("expected error " .. repr(tostring(err)) .. " to contain " .. repr(pattern))
    end
  end
  return m
end

-- -------------------------------------------------------- describe / test

local function full_name(name)
  if #describe_stack == 0 then
    return name
  end
  return table.concat(describe_stack, " > ") .. " > " .. name
end

function describe(name, fn)
  if type(fn) ~= "function" then
    error("describe(name, fn) needs a function", 2)
  end
  table.insert(describe_stack, tostring(name))
  local ok, err = xpcall(fn, on_error)
  if not ok then
    -- A body that errors outside any test still records a failure: a
    -- broken describe must never gate as green-by-absence.
    local message, line = failure_fields(err)
    table.insert(results, {
      name = full_name("(describe body)"),
      passed = false,
      message = message,
      line = line,
    })
  end
  table.remove(describe_stack)
end

function test(name, fn)
  if type(fn) ~= "function" then
    error("test(name, fn) needs a function", 2)
  end
  local case = { name = full_name(tostring(name)), passed = true, message = "", line = 0 }
  local ok, err = xpcall(fn, on_error)
  if not ok then
    case.passed = false
    case.message, case.line = failure_fields(err)
  end
  table.insert(results, case)
end

-- ------------------------------------------------------------- DCS stubs

dcs = { calls = {} }

local function record(name, ...)
  table.insert(dcs.calls, { fn = name, args = { ... } })
end

-- A stub table that errors on unstubbed members instead of yielding nil.
local function stub_table(prefix, fields)
  return setmetatable(fields, {
    __index = function(_, key)
      error("not stubbed yet: " .. prefix .. "." .. tostring(key), 2)
    end,
  })
end

local clock = 0
local schedule = {}
local schedule_seq = 0
local next_timer_id = 1

timer = stub_table("timer", {
  getTime = function()
    return clock
  end,
  scheduleFunction = function(fn, args, time)
    record("timer.scheduleFunction", fn, args, time)
    local id = next_timer_id
    next_timer_id = next_timer_id + 1
    schedule_seq = schedule_seq + 1
    table.insert(schedule, { id = id, fn = fn, args = args, time = time, seq = schedule_seq })
    return id
  end,
  removeFunction = function(id)
    record("timer.removeFunction", id)
    for i, item in ipairs(schedule) do
      if item.id == id then
        table.remove(schedule, i)
        return
      end
    end
  end,
})

trigger = stub_table("trigger", {
  action = stub_table("trigger.action", {
    outText = function(text, displayTime, clearview)
      record("trigger.action.outText", text, displayTime, clearview)
    end,
  }),
})

env = stub_table("env", {
  info = function(message)
    record("env.info", message)
  end,
  warning = function(message)
    record("env.warning", message)
  end,
  error = function(message)
    record("env.error", message)
  end,
})

local event_handlers = {}

world = stub_table("world", {
  addEventHandler = function(handler)
    record("world.addEventHandler", handler)
    table.insert(event_handlers, handler)
  end,
  removeEventHandler = function(handler)
    record("world.removeEventHandler", handler)
    for i, registered in ipairs(event_handlers) do
      if registered == handler then
        table.remove(event_handlers, i)
        return
      end
    end
  end,
})

-- Known DCS globals with no stub yet.
local UNSTUBBED_DCS_GLOBALS = {
  AI = true,
  Airbase = true,
  Controller = true,
  Group = true,
  Object = true,
  SceneryObject = true,
  Spot = true,
  StaticObject = true,
  Unit = true,
  Warehouse = true,
  Weapon = true,
  atmosphere = true,
  coalition = true,
  coord = true,
  country = true,
  land = true,
  missionCommands = true,
  net = true,
  radio = true,
}

setmetatable(_G, {
  __index = function(_, key)
    if UNSTUBBED_DCS_GLOBALS[key] then
      error("not stubbed yet: " .. tostring(key), 2)
    end
    return nil
  end,
})

-- ---------------------------------------------------------- manual clock

runner = stub_table("runner", {
  advanceTime = function(seconds)
    local target = clock + seconds
    while true do
      -- Earliest due deadline wins; equal deadlines fire FIFO by seq.
      local best, best_index
      for i, item in ipairs(schedule) do
        if item.time <= target then
          if not best or item.time < best.time or (item.time == best.time and item.seq < best.seq) then
            best, best_index = item, i
          end
        end
      end
      if not best then
        break
      end
      table.remove(schedule, best_index)
      if best.time > clock then
        clock = best.time
      end
      local next_time = best.fn(best.args, clock)
      if type(next_time) == "number" then
        -- DCS semantics: a returned time reschedules the function. A
        -- non-future time would loop this advance forever — refuse it.
        if next_time <= clock then
          error(
            "scheduled function rescheduled itself at a non-future time ("
              .. tostring(next_time)
              .. " <= "
              .. tostring(clock)
              .. ")",
            2
          )
        end
        schedule_seq = schedule_seq + 1
        table.insert(schedule, {
          id = best.id,
          fn = best.fn,
          args = best.args,
          time = next_time,
          seq = schedule_seq,
        })
      end
    end
    clock = target
  end,
})

return {
  finalize = function()
    return results
  end,
}
