---
column: todo
labels: [bug, bridge]
priority: high
updatedAt: 2026-07-30T00:35:00.000Z
---
# Neither bridge serves at the shipped `warn` log level — the port binds, then refuses

Found by the 2026-07-30 live-verification session (journalled on cards 16 and
18). With `logger_level = "warn"` — the level card 16 made actually arrive —
**both bridges report themselves serving and then refuse every connection.**
Raise the level to `info` or `trace` and the same build, same machine, same
mission serves normally.

This is a total loss of function: with the current tree deployed, the VS Code
extension reads `DCS: offline` forever and no RPC works at all.

**Why nobody saw it before card 16:** every previous live session ran at TRACE,
because the configured level never reached the DLL — that *was* card 16's bug.
Card 16's fix is the first time either bridge has actually run at `warn` inside
DCS, and it uncovered this latent fault. The fix is not wrong; it exposed this.

## Evidence (all one session, same DLLs, only the level literal changed)

| Bridge | Level | `dcs.log` says | Port |
|---|---|---|---|
| GUI (`:25569`) | `warn` | `dcs_studio_gui serving JSON-RPC on 127.0.0.1:25569` | **refused** (2 launches) |
| GUI (`:25569`) | `info` | same | **OK** |
| GUI (`:25569`) | `trace` | same | **OK** |
| Mission (`:25570`) | `warn` | `mission bridge serving JSON-RPC on 127.0.0.1:25570` | **refused** (2 missions) |
| Mission (`:25570`) | `info` | same | **OK** |

Controls that rule out the environment: loopback into the DCS process is fine —
the user's `dcs-fiddle` hook bound `127.0.0.1:12081` in the *same process* and a
TCP connect to it succeeded while `:25569` refused. `netstat` showed **no
listener at all** on 25569/25570 in the failing runs, so the listener is gone
rather than wedged. The GUI failure was reproduced on two separate launches and
the mission failure on two separate missions.

## Where to look

The listener is created synchronously by `.bind((host, port))?` in
`bridge/crates/bridge-core/src/jsonrpc/server.rs:164`, and `new()` returned Ok
in every failing run — the hook logs its success line only after the whole
startup pcall completes (`bridge/hook/DcsStudio.lua:114`). So the socket **was**
bound and then stopped existing. The suspect is the hand-off immediately after:

```rust
let server = HttpServer::new(...).workers(1).bind((host, port))?.run();
let handle = server.handle();
thread::spawn(move || {
    info!("Starting server in new thread");                 // <-- a no-op at warn
    actix_web::rt::System::new().block_on(async {
        info!("Server run finished: {:?}", server.await);
    });
});
```

`bridge/crates/bridge-core/src/jsonrpc/server.rs:167-176`. `run()` is called on
the DCS Lua thread, which has no actix `System`; the returned `Server` future is
carried to a new thread and only there given a runtime. That the behaviour flips
on whether the first `info!` is enabled points at a startup ordering/race that
the logging call's I/O currently hides — i.e. the level is a *timing* accident,
not the cause. Nothing in `logging.rs` can close a socket.

Likely correct shape: build, bind and run the server **inside** the thread that
owns the `System`, and hand the bind result back to the caller over a channel so
a real bind failure still surfaces as an error to Lua instead of a silent
success. A logging call must not be load-bearing for the listener.

## Checklist

- [ ] Reproduce headlessly (a Lua 5.1 host + the DLL at `warn` vs `info`), so this is testable without the sim
- [ ] Fix the server startup so the listener does not depend on log level or thread timing
- [ ] Surface a genuine bind failure to Lua as an error rather than a logged success
- [ ] Add a regression test that starts the server at `warn` and connects
- [ ] Live-verify both bridges serve at the shipped level

## Comments

- **opus-verify** (2026-07-30T00:35:00.000Z): Filed from the live session. Discovered by accident and it very nearly invalidated the whole session: the first card-18 crash runs looked like a **pass** purely because the mission bridge's listener was dead, so nothing was ever served during teardown. Detected it because `:25569/health` refused while `dcs.log` carried the hook's own success line (`bridge/hook/DcsStudio.lua:114`), then bisected the level across five launches — `warn` fails, `info` and `trace` work, in both DLLs independently. The mission bridge's level is a *separate* hard-coded literal in the boot snippet (`bridge/crates/bridge-core/lua/gui_methods.lua:239`), which is why it failed even when I raised the hook's level, and raising that literal to `info` is what finally produced a serving mission bridge. Treat this as P0 ahead of card 16 going anywhere: as shipped on `main` today, the bridge does not work at all.
