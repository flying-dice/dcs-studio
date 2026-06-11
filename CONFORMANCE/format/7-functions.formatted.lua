function mod.util.clamp(value, min, max)
    if value < min then
        return min
    end
    return value
end
function mod.Unit:getName()
    return self.name
end
local function noop() end
local function pass(...)
    return ...
end
local function mixed(a, b, ...)
    return a, b, ...
end
local f = function() end
local g = function(x)
    return x * 2
end
