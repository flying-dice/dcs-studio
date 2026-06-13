-- file header comment
local a = 1 -- trailing comment
--[[ block
comment spans lines ]]
local b = 2
---@param x number
---@return number
function f(x)
    -- inside body
    return x --[=[ keeps level ]=]
end
