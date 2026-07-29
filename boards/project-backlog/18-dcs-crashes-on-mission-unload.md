---
column: todo
labels: [bug, bridge]
priority: high
updatedAt: 2026-07-29T19:20:00.000Z
---
# DCS crashes on every mission unload with the bridge deployed — is the bridge the cause?

Found while attempting card 04's two-mission run: this install **crashed on
every return from a mission to the main menu — three reproductions, three
different methods** (`DCS.stopMission()` via RPC, and QUIT through the UI
twice). The crash is what made card 04's verdict inconclusive.

It is not yet established that the bridge is the cause — but the mission DLL
stays loaded from first mission until process exit, its Lua state is being
torn down at exactly that moment, and teardown sampling showed the mission
listener dropping ~2.5 s before the GUI one with the process still alive. A
crash in a user's sim on every mission exit would be the worst bug this
project could ship, so cause-or-exoneration is the priority, ahead of
features.

First discriminator: reproduce the mission-exit path **with the bridge DLLs
and hook removed**. If it still crashes, this is an install problem and the
card closes with that evidence. If it stops, bisect: hook without mission DLL,
then mission DLL without an active debug session, then with one.

Check `Logs/dcs.log` tail and any crash dump under the write dir from the
card 03/04 session (2026-07-29 evening) before re-reproducing — the evidence
may already be on disk.

## Checklist

- [ ] Read the existing crash evidence from the 2026-07-29 session (dcs.log tail, crash dumps)
- [ ] Reproduce mission exit with no bridge deployed — crash or clean?
- [ ] If bridge-implicated: bisect hook / GUI DLL / mission DLL / active debug session
- [ ] File the outcome as a GitHub issue with the evidence either way
