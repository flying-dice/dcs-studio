-- teaser-mod: runs when the mission starts. Logs a tagged line to the DCS log
-- (Saved Games\DCS\Logs\dcs.log) so the IDE's "DCS Log" viewer highlights and
-- filters our output. Mission scripts log via env.* (subsystem SCRIPTING), so
-- we prefix every line with the mod tag for the viewer to key on.
local TAG = "teaser-mod"

local function log(message)
  env.info(TAG .. ": " .. message)
end

log("loaded — model time " .. tostring(timer.getTime()))

-- Greet every plane that spawns, so there's live output to watch in the viewer.
local function onBirth(event)
  if event.id == world.event.S_EVENT_BIRTH and event.initiator then
    local name = event.initiator:getName() or "unknown"
    log("unit spawned: " .. name)
  end
end

world.addEventHandler({ onEvent = onBirth })
