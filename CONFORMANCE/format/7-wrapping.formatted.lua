trigger.action.outTextForCoalition(
    coalition.side.BLUE,
    "This is a long, long message for the blue coalition pilots",
    15,
    false
)
local zones = {
    alpha = "Zone Alpha",
    bravo = "Zone Bravo",
    charlie = "Zone Charlie",
    delta = "Zone Delta",
}
timer.scheduleFunction(
    function(arg, time)
        return time + 1
    end,
    nil,
    timer.getTime() + 10
)
local short = math.max(1, 2)
