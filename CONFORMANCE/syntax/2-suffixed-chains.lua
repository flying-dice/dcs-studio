local name = unit:getName()
trigger.action.outText(name, 10)
group.units[1].life = group.units[1].life - 1
f 'string-call' { table_call = true }
