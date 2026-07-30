#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
// idiomatic in tests

//! The JSON-RPC server as the editor actually reaches it: a live bridge bound
//! to a loopback port, driven over real HTTP and a real WebSocket.
//!
//! The unit tests in `jsonrpc::server` cover the request pipeline in process;
//! everything here needs a bound socket — the health probe an agent uses to
//! tell the two bridges apart, the `POST /rpc` transport, the WebSocket read
//! loop's frame handling, the mission-reload path through `jsonrpc.serve`, and
//! the teardown that has to survive being called from `Drop` inside DCS.
//!
//! Windows-gated like the rest of the suite: the test binary links DCS's own
//! lua.dll, so put it on PATH and run with `-- --include-ignored`.

mod support;

use std::sync::{mpsc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

/// Every test here binds loopback ports and drives one Lua state's bridge from
/// outside it. Running them one at a time keeps each test's assertions about
/// "this port" true — several assert that a port is refused once its owning state
/// has let go, which a sibling rebinding meanwhile would falsify.
static SERIAL: Mutex<()> = Mutex::new(());

fn serially() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(PoisonError::into_inner)
}

use dcs_bridge_core::{bootstrap, BridgeKind};
use mlua::{Function, Lua};
use support::lua_cov::CoveredLua;
use support::{connect_ws, free_port, get, notification, post_rpc, rpc};

/// A live bridge on `port`, driven from a dedicated "sim thread" that owns the
/// Lua state (mlua states are not `Send`, exactly as in DCS where everything
/// runs on the sim's main loop).
///
/// The thread answers `Command`s so a test can decide when the queue is
/// drained — the whole point of the design is that requests sit in the queue
/// until the sim pumps them, so a test that wants an unanswered request simply
/// does not send `Pump`.
enum Command {
    /// Drain the server's queue through the router (one simulation frame).
    Pump,
    /// Bind ANOTHER server through `jsonrpc.serve`, as the next mission's init
    /// does — parked in a Lua global the harness can then drop.
    Reserve(u16, mpsc::Sender<Result<(), String>>),
    /// Drop the server `Reserve` parked, and collect it.
    ReleaseNext(mpsc::Sender<()>),
    /// Evaluate a Lua chunk and hand back its string result.
    Eval(String, mpsc::Sender<String>),
    /// End the bridge and exit the thread. `true` calls `server:stop()` first;
    /// `false` only drops the userdata, so `Drop` is what stops it.
    Shutdown(bool),
}

struct Bridge {
    port: u16,
    commands: mpsc::Sender<Command>,
    joined: Option<std::thread::JoinHandle<()>>,
}

impl Bridge {
    /// Bind a bridge on a free port with `timeout` seconds per request and
    /// wire a router with the handlers the tests exercise.
    fn start(timeout: u64) -> Bridge {
        let port = free_port();
        let (commands, inbox) = mpsc::channel::<Command>();
        let (ready, is_ready) = mpsc::channel::<()>();

        let joined = std::thread::spawn(move || {
            let lua = Lua::new();
            // Lua line coverage (#66); inert unless `LUA_COV_DIR` is set. This
            // state is `Lua::new()`, which has no `debug` library, so the shim
            // declines here — the same decline path `bootstrap` has.
            let lua = CoveredLua::new(lua);
            let exports = bootstrap(&lua, BridgeKind::Mission, "test").expect("bootstrap");
            let glue = format!(
                r#"
local bridge = ...
server = bridge.jsonrpc.serve({{ host = "127.0.0.1", port = {port}, timeout = {timeout}, env = "mission" }})
router = bridge.jsonrpc.JsonRpcRouter.new()
router:add_method("echo", function(p) return p end, {{ description = "Echo the params back." }})
router:add_method("bump", function(p) bumped = (bumped or 0) + 1; return {{ n = bumped }} end)
router:add_method("boom", function() error("handler exploded") end)
router:add_method("cyclic", function() local t = {{}}; t.self = t; return t end)
pump = function() server:process_rpc(router) end
-- Each `serve` binds its OWN server: a state parks each one it means to keep,
-- and letting go of it is what stops that one.
reserve = function(port) NEXT = bridge.jsonrpc.serve({{ host = "127.0.0.1", port = port, env = "mission" }}) end
release_next = function() NEXT = nil; collectgarbage("collect"); collectgarbage("collect") end
"#
            );
            lua.load(&glue)
                .set_name("=harness")
                .call::<()>(&exports)
                .expect("wire the bridge");
            let _ = ready.send(());

            let globals = lua.globals();
            while let Ok(command) = inbox.recv() {
                match command {
                    Command::Pump => globals
                        .get::<Function>("pump")
                        .and_then(|f| f.call::<()>(()))
                        .expect("pump"),
                    Command::Reserve(port, reply) => {
                        let outcome = globals
                            .get::<Function>("reserve")
                            .and_then(|f| f.call::<()>(port))
                            .map_err(|e| e.to_string());
                        let _ = reply.send(outcome);
                    }
                    Command::ReleaseNext(reply) => {
                        globals
                            .get::<Function>("release_next")
                            .and_then(|f| f.call::<()>(()))
                            .expect("release the parked server");
                        let _ = reply.send(());
                    }
                    Command::Eval(chunk, reply) => {
                        let out: String = lua.load(&chunk).eval().expect("eval");
                        let _ = reply.send(out);
                    }
                    Command::Shutdown(explicit_stop) => {
                        if explicit_stop {
                            lua.load("server:stop()").exec().expect("stop");
                        }
                        // Drop the userdata and collect it, so `Drop` runs here
                        // rather than at process exit. For a server nobody
                        // stopped, `Drop` is the ONLY thing that stops it —
                        // exactly as DCS's lua_close is inside the sim.
                        lua.globals()
                            .set("server", mlua::Value::Nil)
                            .expect("clear");
                        lua.gc_collect().expect("gc");
                        lua.gc_collect().expect("gc again");
                        break;
                    }
                }
            }
        });

        is_ready
            .recv_timeout(Duration::from_secs(20))
            .expect("bridge ready");
        Bridge {
            port,
            commands,
            joined: Some(joined),
        }
    }

    fn pump(&self) {
        self.commands.send(Command::Pump).expect("pump");
    }

    /// Bind another server on `port`, parked in the state as `NEXT`.
    fn reserve(&self, port: u16) -> Result<(), String> {
        let (reply, answer) = mpsc::channel();
        self.commands
            .send(Command::Reserve(port, reply))
            .expect("reserve");
        answer
            .recv_timeout(Duration::from_secs(10))
            .expect("reserved")
    }

    /// Let the state stop holding `NEXT`, and collect it.
    fn release_next(&self) {
        let (reply, answer) = mpsc::channel();
        self.commands
            .send(Command::ReleaseNext(reply))
            .expect("release");
        answer
            .recv_timeout(Duration::from_secs(10))
            .expect("released");
    }

    /// `jsonrpc.serve` through `pcall`, so a refused bind can be inspected
    /// rather than unwinding the harness thread.
    fn try_reserve(&self, port: u16) -> Result<(), String> {
        let out = self.eval(&format!(
            "local ok, res = pcall(reserve, {port}); return tostring(ok) .. '|' .. tostring(res)"
        ));
        match out.split_once('|') {
            Some(("true", _)) => Ok(()),
            Some((_, cause)) => Err(cause.to_string()),
            None => panic!("malformed reserve result: {out}"),
        }
    }

    fn eval(&self, chunk: &str) -> String {
        let (reply, answer) = mpsc::channel();
        self.commands
            .send(Command::Eval(chunk.to_string(), reply))
            .expect("eval");
        answer
            .recv_timeout(Duration::from_secs(10))
            .expect("evaluated")
    }

    /// Pump every 20ms until `f` succeeds or the deadline passes — the sim
    /// thread's frame loop, on demand.
    fn pump_until<T>(&self, mut f: impl FnMut() -> Option<T>, wait: Duration) -> Option<T> {
        let deadline = std::time::Instant::now() + wait;
        while std::time::Instant::now() < deadline {
            self.pump();
            if let Some(value) = f() {
                return Some(value);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        None
    }

    fn shutdown(mut self, explicit_stop: bool) {
        let _ = self.commands.send(Command::Shutdown(explicit_stop));
        if let Some(handle) = self.joined.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        if let Some(handle) = self.joined.take() {
            let _ = self.commands.send(Command::Shutdown(true));
            let _ = handle.join();
        }
    }
}

/// `/health` is how an agent probing 25569/25570 tells the two bridges apart,
/// and it must answer without the sim thread pumping anything — the sim can be
/// paused at a breakpoint when the probe arrives.
#[test]
#[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
fn health_identifies_the_bridge_without_the_sim_pumping() {
    let _serial = serially();
    let bridge = Bridge::start(5);

    let (status, body) = get(bridge.port, "/health");
    assert!(status.contains("200"), "{status}");
    assert!(body.contains(r#""name":"dcs-studio-mission""#), "{body}");
    assert!(body.contains(r#""env":"mission""#), "{body}");
    assert!(body.contains(r#""status":"OK""#), "{body}");
    assert!(body.contains(r#""version""#), "{body}");

    bridge.shutdown(true);
}

/// `POST /rpc` is the transport the MCP tools use. A request waits for the sim
/// to answer it; a notification is accepted immediately, because there is no
/// id to answer to and the caller must not be left holding a frame's worth of
/// latency for a fire-and-forget call.
#[test]
#[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
fn posting_a_request_waits_for_the_sim_while_a_notification_is_accepted_at_once() {
    let _serial = serially();
    let bridge = Bridge::start(10);

    // The notification is accepted before anything drains the queue.
    let (status, body) = post_rpc(bridge.port, &notification("bump", "{}"));
    assert!(status.contains("202"), "{status}");
    assert_eq!(body, "OK");

    // The request needs the sim thread; pump from here while it is in flight.
    let port = bridge.port;
    let (done, answer) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = done.send(post_rpc(port, &rpc("1", "echo", r#"{"n":42}"#)));
    });
    let (status, body) = bridge
        .pump_until(
            || answer.recv_timeout(Duration::from_millis(10)).ok(),
            Duration::from_secs(10),
        )
        .expect("the pumped request must be answered");
    assert!(status.contains("200"), "{status}");
    assert!(body.contains(r#""id":"1""#), "{body}");
    assert!(body.contains(r#""n":42"#), "{body}");

    // The notification's side effect ran too — it was queued, not discarded.
    bridge.pump();
    assert_eq!(bridge.eval("return tostring(bumped)"), "1");

    bridge.shutdown(true);
}

/// A request nobody drains must time out with an error rather than pin the
/// connection forever: inside DCS the sim thread can stop pumping (a load
/// screen, a paused mission), and an editor left blocked on a dead request is
/// indistinguishable from a hung IDE.
#[test]
#[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
fn an_undrained_request_times_out_instead_of_hanging_the_caller() {
    let _serial = serially();
    let bridge = Bridge::start(1);

    let (status, _body) = post_rpc(bridge.port, &rpc("slow", "echo", "{}"));
    assert!(
        status.contains("500"),
        "an undrained request must fail, got {status}"
    );

    // The same on the WebSocket, where the editor lives: the request expires
    // on the server's own timeout and is simply never answered, and — the part
    // that matters — the SESSION survives it, so the editor's next request is
    // still served once the sim resumes pumping.
    let mut ws = connect_ws(bridge.port);
    ws.send(&rpc("expired", "echo", "{}")).expect("send");
    // The barrier proves the server has READ that frame — without it the
    // assertion below ("no answer arrives") is also satisfied by a runner that
    // never got to the request at all, and the timeout path goes unexercised.
    assert!(
        ws.barrier(Duration::from_secs(10)),
        "the server must have read the request before we wait for it to expire"
    );
    assert!(
        ws.await_id("expired", Duration::from_secs(3)).is_none(),
        "an undrained WS request must expire rather than be answered late"
    );

    ws.send(&rpc("after", "echo", "{}")).expect("send after");
    assert!(
        bridge
            .pump_until(
                || ws.await_id("after", Duration::from_millis(50)),
                Duration::from_secs(10)
            )
            .is_some(),
        "the session must outlive one expired request"
    );

    bridge.shutdown(false);
}

/// `GET /ws` is only a WebSocket when the client asks for the upgrade. A plain
/// GET — a browser, a curl, an agent probing the port for `/health` and
/// mistyping it — must be refused with a status, not take the actix worker
/// down: this server has one worker, and losing it loses the bridge for the
/// rest of the DCS session.
#[test]
#[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
fn a_plain_get_on_the_websocket_route_is_refused_and_the_bridge_survives() {
    let _serial = serially();
    let bridge = Bridge::start(5);

    let (status, _body) = get(bridge.port, "/ws");
    assert!(
        status.contains("400"),
        "a non-upgrade GET /ws must be refused, got {status}"
    );

    // The bridge is still serving: the refusal cost one request, nothing more.
    let (health, body) = get(bridge.port, "/health");
    assert!(health.contains("200"), "{health}");
    assert!(body.contains(r#""status":"OK""#), "{body}");
    let mut ws = connect_ws(bridge.port);
    ws.send(&rpc("still", "echo", "{}")).expect("send");
    assert!(
        bridge
            .pump_until(
                || ws.await_id("still", Duration::from_millis(50)),
                Duration::from_secs(10)
            )
            .is_some(),
        "a real upgrade still works after the refusal"
    );

    bridge.shutdown(true);
}

/// The WebSocket read loop is the editor's long-lived connection. Requests,
/// notifications, failing handlers, unserializable results, `rpc.discover`, and
/// one malformed frame all have to be survivable — a dropped session mid-debug
/// loses every later step and inspect.
#[test]
#[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
fn the_websocket_session_survives_every_frame_the_editor_can_send() {
    let _serial = serially();
    let bridge = Bridge::start(10);
    let mut ws = connect_ws(bridge.port);

    // A frame that is not JSON, and one whose id is numeric (the shape that
    // fails serde on this wire format) — both skipped, session intact.
    ws.send("}{ not json").expect("send garbage");
    ws.send(r#"{"jsonrpc":"2.0","id":9,"method":"echo","params":{}}"#)
        .expect("send numeric id");
    // A notification: queued, answered by nothing.
    ws.send(&notification("bump", "{}"))
        .expect("send notification");

    ws.send(&rpc("ok", "echo", r#"{"n":1}"#))
        .expect("send echo");
    ws.send(&rpc("err", "boom", "{}")).expect("send boom");
    ws.send(&rpc("bad", "cyclic", "{}")).expect("send cyclic");
    ws.send(&rpc("miss", "nope", "{}")).expect("send unknown");
    ws.send(&rpc("disc", "rpc.discover", "{}"))
        .expect("send discover");

    let mut seen: Vec<String> = Vec::new();
    bridge.pump_until(
        || {
            while let Some(message) = ws.poll(Duration::from_millis(20)) {
                seen.push(message);
            }
            (seen.len() >= 5).then_some(())
        },
        Duration::from_secs(15),
    );

    let joined = seen.join("\n");
    assert!(joined.contains(r#""n":1"#), "echo: {joined}");
    assert!(joined.contains("handler exploded"), "raise: {joined}");
    assert!(
        joined.contains("result not serializable"),
        "cyclic: {joined}"
    );
    assert!(
        joined.contains("Method not found: nope"),
        "unknown: {joined}"
    );
    assert!(joined.contains("openrpc"), "discover: {joined}");
    assert_eq!(
        seen.len(),
        5,
        "the two bad frames produced no reply: {joined}"
    );

    // The side effect of the notification still ran.
    assert_eq!(bridge.eval("return tostring(bumped)"), "1");

    bridge.shutdown(true);
}

/// Control frames: a Ping must be ponged (the editor's keepalive — an
/// unanswered one has the client tear the connection down mid-session), and a
/// Close must be echoed and end the read loop.
#[test]
#[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
fn a_ping_is_ponged_and_a_close_ends_the_session() {
    let _serial = serially();
    let bridge = Bridge::start(5);

    let mut ws = connect_ws(bridge.port);
    ws.ping(b"hi").expect("ping");
    let raw = ws.read_raw(Duration::from_secs(10));
    assert_eq!(
        raw.first().map(|b| b & 0x0f),
        Some(0xa),
        "pong opcode: {raw:?}"
    );

    ws.close().expect("close");
    let echoed = ws.read_raw(Duration::from_secs(10));
    assert_eq!(
        echoed.first().map(|b| b & 0x0f),
        Some(0x8),
        "close echo: {echoed:?}"
    );

    // A frame this server does not serve ends the loop rather than being
    // misread as a request. Observed as the session CLOSING, not as the absence
    // of an answer: an absence is also what a runner too busy to have read the
    // frame yet would show, which would pass while covering nothing.
    let mut other = connect_ws(bridge.port);
    other.binary(b"\x00\x01").expect("binary");
    assert!(
        other.wait_until_closed(Duration::from_secs(10)),
        "the read loop must end on the binary frame"
    );

    bridge.shutdown(true);
}

/// An editor that closes the socket while a request is still queued is
/// ordinary: the user hit Disconnect, or reloaded the window, mid-`debug_run`.
/// The sim still answers the request a frame later and finds the session gone —
/// which must be one logged dead request, not a dropped bridge. The next
/// connection has to work.
#[test]
#[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
fn a_client_that_closes_mid_request_costs_only_that_request() {
    let _serial = serially();
    let bridge = Bridge::start(30);

    let mut ws = connect_ws(bridge.port);
    // Queue the request, then close BEFORE the sim drains it: the server echoes
    // the close and ends the session while the answer is still owed.
    ws.send(&rpc("orphaned", "echo", "{}")).expect("send");
    ws.close().expect("close");
    let echoed = ws.read_raw(Duration::from_secs(5));
    assert_eq!(
        echoed.first().map(|b| b & 0x0f),
        Some(0x8),
        "the server must echo the close first: {echoed:?}"
    );

    // Now answer it. The write has nowhere to go, and that is the whole test:
    // the drain must not care.
    bridge.pump();
    bridge.pump();

    let mut fresh = connect_ws(bridge.port);
    fresh.send(&rpc("next", "echo", "{}")).expect("send");
    assert!(
        bridge
            .pump_until(
                || fresh.await_id("next", Duration::from_millis(50)),
                Duration::from_secs(10)
            )
            .is_some(),
        "the bridge must still serve the next connection"
    );

    bridge.shutdown(true);
}

/// `jsonrpc.serve` is what the mission DLL's init calls on EVERY mission load,
/// and since card 18's third iteration each call binds a server the CALLING LUA
/// STATE owns. So the mission-reload contract is ownership, not reuse: the state
/// lets go, the listener goes with it and its stranded callers are told, and the
/// port is free for the next mission to bind. Over a real socket, because
/// "accepted connections" is the condition the crash tracked.
#[test]
#[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
fn serving_per_mission_hands_the_port_back_when_the_state_lets_go() {
    let _serial = serially();
    let bridge = Bridge::start(30);

    // A port something else already holds cannot be bound, and the failure
    // reaches Lua as an error rather than a half-started server: the mission
    // init pcalls this and reports "bridge server failed to start" to the user.
    let taken = std::net::TcpListener::bind("127.0.0.1:0").expect("occupy a port");
    let taken_port = taken.local_addr().expect("addr").port();
    let refused = bridge
        .try_reserve(taken_port)
        .expect_err("an occupied port must be refused");
    assert!(!refused.is_empty(), "the bind failure must carry a cause");
    drop(taken);

    // One mission's serve binds its own listener, and it really serves.
    let served = free_port();
    bridge.reserve(served).expect("the first serve binds");
    assert!(
        get(served, "/health").1.contains("dcs-studio-mission"),
        "the mission's own server answers on its own port"
    );

    // Strand a request in that server's queue: the sim never pumps it, which is
    // exactly what a mission ending mid-request looks like.
    let mut ws = connect_ws(served);
    ws.send(&rpc("stranded", "echo", "{}")).expect("send");
    // It must be QUEUED before the state lets go, or there is nothing stranded
    // and the test proves nothing. The barrier is that proof: one connection's
    // frames are read in order, so a Pong means the request is already in the
    // queue. (A sleep here proved nothing — on a loaded runner the frame can
    // still be unread when it expires.)
    assert!(
        ws.barrier(Duration::from_secs(10)),
        "the server must have queued the stranded request before the release"
    );

    // The mission ends: the state stops holding the userdata, and that alone —
    // no stop call, no event — must end the server. Its stranded caller is told
    // the truth on the way out rather than left to age out or be answered by a
    // later mission: over the WebSocket, before the socket is cut.
    bridge.release_next();
    let answer = ws
        .await_id("stranded", Duration::from_secs(5))
        .expect("the stranded caller must be answered, not left waiting");
    assert!(
        answer.contains("-32001") && answer.contains("bridge torn down"),
        "and answered with the reason, not a result: {answer}"
    );

    // The next mission binds the SAME port, which is only possible because the
    // previous one's listener is genuinely gone.
    bridge
        .reserve(served)
        .expect("the port came back with the state that owned it");
    assert!(
        get(served, "/health").1.contains("dcs-studio-mission"),
        "the next mission is served by its own fresh server"
    );
    bridge.release_next();

    bridge.shutdown(true);
}

/// A server has to stop when Lua says so (`server:stop()`) and again when the
/// userdata is merely collected — the second being the path DCS takes for a
/// mission that never fires its end event. A failure in either is a panic inside
/// DCS: `Drop` runs from `__gc` during `lua_close`, and a panic there aborts the
/// process.
#[test]
#[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
fn a_server_stops_from_lua_and_again_when_it_is_collected() {
    let _serial = serially();
    let bridge = Bridge::start(5);
    // `tostring` on both userdata types is what a modder sees when they print
    // a handle; a raising __tostring there would abort their script.
    let shown = bridge.eval("return tostring(server)");
    assert!(shown.starts_with("JsonRpcServer("), "{shown}");
    assert!(shown.contains("127.0.0.1"), "{shown}");
    let routed = bridge.eval("return tostring(router)");
    assert!(routed.starts_with("JsonRpcRouter("), "{routed}");
    assert!(routed.contains("echo"), "{routed}");
    // `shutdown` stops the server and then drops + collects the userdata, so
    // both the explicit stop and `Drop`'s own stop run.
    bridge.shutdown(true);

    let again = Bridge::start(5);
    again.shutdown(false);
}
