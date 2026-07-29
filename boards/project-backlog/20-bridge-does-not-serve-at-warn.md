---
column: doing
labels: [bug, bridge]
priority: high
agent: opus-server-start
live: true
status: Fixed and gated headlessly; live-verify pending the next sim session
progress: 85
updatedAt: 2026-07-30T03:10:00.000Z
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

- [x] Reproduce headlessly — no Lua host needed at all; a plain Rust test at `warn` reproduces it 100% of the time
- [x] Fix the server startup so the listener does not depend on log level or thread timing
- [x] Surface a genuine bind failure to Lua as an error rather than a logged success
- [x] Add a regression test that starts the server at `warn` and connects
- [ ] Live-verify both bridges serve at the shipped level

## Comments

- **opus-verify** (2026-07-30T00:35:00.000Z): Filed from the live session. Discovered by accident and it very nearly invalidated the whole session: the first card-18 crash runs looked like a **pass** purely because the mission bridge's listener was dead, so nothing was ever served during teardown. Detected it because `:25569/health` refused while `dcs.log` carried the hook's own success line (`bridge/hook/DcsStudio.lua:114`), then bisected the level across five launches — `warn` fails, `info` and `trace` work, in both DLLs independently. The mission bridge's level is a *separate* hard-coded literal in the boot snippet (`bridge/crates/bridge-core/lua/gui_methods.lua:239`), which is why it failed even when I raised the hook's level, and raising that literal to `info` is what finally produced a serving mission bridge. Treat this as P0 ahead of card 16 going anywhere: as shipped on `main` today, the bridge does not work at all.
- **opus-server-start** (2026-07-30T03:10:00.000Z): **Mechanism found, and it is not a race — it is fully deterministic.** `log`'s macros do not evaluate their arguments when the level is disabled: `info!(...)` expands to `if Info <= max_level() { … format_args!(args) }`. The ONLY thing that ever polled the `Server` future was `server.await` sitting *inside* an `info!` argument list (`bridge/crates/bridge-core/src/jsonrpc/server.rs:174` on the old tree). At `warn`, `Info <= Warn` is false, so that `await` never happened. An actix `Server` is `#[must_use = "does nothing unless you .await or poll it"]` — unpolled it never starts the accept loop, and the closure then dropped it, which closed the listener actix-web had already bound in `new()`. Exactly the observed signature: `new()` returns Ok, the hook logs success, `netstat` shows no listener, every connect refused. The "startup ordering/race" and "the info! call's I/O masking it" hypotheses in the description are wrong — nothing was racing; the fix line was simply compiled out at anything below `info`. Nothing in `logging.rs` was involved, correctly.
- **opus-server-start** (2026-07-30T03:12:00.000Z): **Fix** at `bridge/crates/bridge-core/src/jsonrpc/server.rs:156-252`. `HttpServer::new` + `.bind()` + `.run()` all now happen inside the `System::new().block_on` on the spawned thread (`server.rs:192-232`), which also removes a second latent hazard: `HttpServer::run` is documented to panic without a Tokio runtime, and the old code called it on the DCS Lua thread. The bind outcome travels back over an `mpsc::sync_channel` (`server.rs:191`) and the caller waits with `recv_timeout(BIND_TIMEOUT)` — 10 s, `server.rs:34-41` — so a real bind failure reaches Lua as an error, a wedged thread costs the startup `pcall` an error instead of hanging the sim thread forever, and a *silently dead* thread is now reported too (`Disconnected` arm, `server.rs:246-251`) rather than swallowed as it was before. If the caller has already timed out when the bind succeeds, the thread releases the port instead of leaving one bound to nothing (`server.rs:215-222`). The `await` is now a statement of its own with the log line after it (`server.rs:229-230`), with a comment saying why it must stay that way.
- **opus-server-start** (2026-07-30T03:14:00.000Z): **Card 18's "machine limitation" was this bug all along.** Card 18's journal recorded that every socket-bound test fails on this box with "connect: actively refused", identically on unmodified `main`, and concluded the machine was refusing loopback accepts. It was not: the test binaries install no logger, and `log`'s default `max_level` is `Off` — strictly quieter than `warn` — so every test that bound a bridge hit precisely this defect. Measured on this worktree's base before touching anything: `jsonrpc_server` **1/9**, `debug_ws_latency` **0/1**. After the fix, on the same Windows box: `jsonrpc_server` **9/9**, `debug_ws_latency` **1/1**. That recovers 9 end-to-end tests that were believed unrunnable here, and it means the loopback path was never in doubt.
- **opus-server-start** (2026-07-30T03:16:00.000Z): **Regression tests**, both in `bridge/crates/bridge-core/src/jsonrpc/server.rs`: `the_bound_listener_serves_at_the_shipped_warn_log_level` (`server.rs:881-908`) pins `log::set_max_level(Warn)`, binds a server, and drives a real `GET /health` over a raw `TcpStream` asserting `200 OK` + `dcs-studio-gui` — it proves the bridge is *serving*, not merely bound. Verified failing on the pre-fix tree (`ConnectionReset`, os error 10054) and passing after, so it genuinely covers the defect. `a_port_already_taken_is_reported_to_the_caller` (`server.rs:910-931`) squats a loopback port and asserts `new()` comes back `Err` naming the OS cause, which is the half of the fix that the channel hand-off could have quietly lost. Both are serialized via `crate::jsonrpc::serially()` because they touch the DLL-wide statics and the process-global log level. Teardown/rearm from card 18 is untouched and its lifecycle test stays green (`jsonrpc::teardown::tests::a_mission_state_is_released_before_it_dies_and_the_next_one_boots_over_it`, plus the `jsonrpc_server` end-to-end `a_server_stops_from_lua_and_again_when_it_is_collected` which now actually runs here for the first time).
- **opus-server-start** (2026-07-30T03:18:00.000Z): **Gates** (in `bridge/`, DCS's `lua.dll` on PATH for the Windows-ignored sets, `lua_panic::tests::the_probe*` skipped as they kill or poison their own binary by design): `cargo fmt --all -- --check` clean; `cargo clippy --all-targets -- -D warnings` clean; `cargo test --workspace` green (35 passed, 94 Windows-ignored). Windows-ignored sweep: bridge-core lib **127/127**, `jsonrpc_server` **9/9**, `debug_ws_latency` **1/1**, `debug_engine_safety` 4/4, `hook_dcs_studio` 12/12, `openrpc_meta_schema` 2/2, bridge-gui 3/3, bridge-mission 5/5 — a clean sweep, no environmental caveat this time. **Proven vs deferred:** proven headlessly and end-to-end that a bridge bound at `warn` serves HTTP and WebSocket, that a taken port errors out to the caller, and that stop/teardown still work; nothing was verified structurally-only. Deferred to live: that both DLLs inside DCS serve on 25569/25570 at the shipped level — the mechanism is level-independent by construction now, but only a sim session closes card 20. **Not launched:** no DCS, no `Saved Games` touched. Both `logger_level` literals are already `warn` on this tree (`bridge/hook/DcsStudio.lua`, `bridge/crates/bridge-core/lua/gui_methods.lua:239`) — no workaround to revert, so the next session tests the shipped level as-is.
