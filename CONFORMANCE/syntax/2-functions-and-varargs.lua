function lib.sub:method(a, b, ...)
  return select('#', ...) + a + b
end
local function helper(...)
  return ...
end
local lambda = function() return nil end
