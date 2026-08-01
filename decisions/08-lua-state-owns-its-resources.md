---
status: Accepted
date: 2026-07-30
---
# Decision 08 — Resources created for a Lua state are owned by that state

Amends [decision 04](04-two-in-process-bridges-over-json-rpc.md), which chose the
two bridges and their transport but said nothing about who owns the server object.
This record answers that, and the answer changes the shape of the code.

## Context

Card 18 investigated a crash with an unusually clean signature: after quitting a
mission, DCS died roughly ten seconds later. Six reproductions out of six
attempts. The cause was not the transport and not the protocol — it was
**lifetime**. The JSON-RPC server was reachable through DLL-scoped state, so it
outlived the mission Lua state that had asked for it. A listener, an actix
`System` thread and a queue of pending requests all survived a `lua_close`,
holding references into a state that no longer existed, and the process paid for
it a few seconds later.

Two earlier iterations of the fix were live-verified and did real work — release
the handlers on `S_EVENT_MISSION_END`, then fail the stranded queue, then stop the
listener. But each iteration was patching *when* to tear down a resource whose
*ownership* was still wrong, and each left a documented gap: a mission that never
fired `S_EVENT_MISSION_END` kept its listener across the unload, and the next
mission inherited it.

The repository owner stopped the third iteration and stated the rule directly, as
a design driver rather than a hypothesis:

> The bridge must respect Lua lifecycles. Resources a Lua-extension DLL creates
> are created in the Lua call and handed back to the Lua environment as mlua
> userdata, with Lua's GC driving shutdown. The Lua state must never be used as a
> mere DLL loader with process-scoped statics — "you get all sorts of issues"
> (the card-18 crash being one).

This is not a first encounter with the problem. The owner has run actix inside
DCS before, and named that prior art as the reference pattern:
`flying-dice/neoc`, `vnd/hyper/server.rs`. This record adopts the pattern rather
than rediscovering it a third time.

## Decision

**A resource a Lua-extension DLL creates for a Lua state is owned by that state.**

- Create it **in the Lua call** that asks for it — `jsonrpc.serve` constructs the
  server; nothing constructs one at DLL load.
- **Return it as mlua userdata.** The userdata owns the whole resource: listener,
  actix `System` thread, and request queue together, not a handle to something
  stored elsewhere.
- **Lua's GC drives shutdown.** `Drop` stops the server, whether it is reached
  from an explicit teardown while the state is alive or from `__gc` inside DCS's
  own `lua_close`.
- **Never use the Lua state as a DLL loader with process statics** for anything
  whose lifetime is the state's. There is no server static and no queue static,
  which is what makes a dead state unreachable rather than merely unreached.

The boot code on each side parks the userdata in its own state — the GameGUI hook
in its frame callbacks, `mission_init.lua` in its pump closures — so "as long as
the state" is expressed by ordinary Lua reachability rather than by a flag.

## Consequences

- **Every mission gets a fresh server and a fresh bind.** Nothing is reused across
  missions and nothing needs arming or re-arming, because a new mission is a new
  state, a new userdata and a new router. There is no stale DLL flag to inherit —
  which is also the end of the inherited-listener gap the earlier iterations left
  open.
- **Drop budgets are bounded, and deliberately asymmetric.** The caller on either
  path is the sim thread, so no wait may be open-ended: 2s + 2s (acknowledge +
  `System` exit) on the explicit teardown, 250ms + 250ms when `Drop` runs from
  `__gc` mid-`lua_close`. The collected path also touches no Lua and cannot
  panic — the state is already dying.
- **The explicit teardown stays, and its order stays load-bearing.** GC-driven
  shutdown is the guarantee, not the plan A: releasing handlers and failing the
  queue while the state is *whole* is cheaper and safer than doing it inside
  `lua_close`. See `bridge/crates/bridge-core/src/jsonrpc/teardown.rs`.
- **The GUI bridge is the same pattern, not an exception.** Its server is owned by
  the GameGUI state exactly as the mission server is owned by the mission state.
  That state simply happens to live for the process, so the rule is invisible
  there — which is the point: one rule, and the lifetime is whatever the state's
  lifetime is.
- New in-DCS resources (databases, watchers, engines) follow this without further
  debate. A process static in a Lua-extension DLL is now something to justify,
  not something to reach for.

## Evidence

Card 18 and [issue #69](https://github.com/flying-dice/dcs-studio/issues/69) —
the crash, the six reproductions, and the live verification of each iteration.
The code carries the rule in its module docs:
`bridge/crates/bridge-core/src/jsonrpc/server.rs` (ownership) and
`.../jsonrpc/teardown.rs` (lifecycle and ordering).
