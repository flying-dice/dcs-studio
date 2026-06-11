local a = 1
local b = 2
local c = 3
local f = print
;(f or print)("guarded")
return a + b + c
