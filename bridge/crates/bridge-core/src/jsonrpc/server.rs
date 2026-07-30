//! The JSON-RPC server, and who owns it.
//!
//! **A resource this DLL creates in a Lua call is handed back to the Lua
//! environment as userdata, and Lua's GC drives its shutdown.** The Lua state is
//! never used as a mere DLL loader with process-scoped statics — that is the
//! repository owner's architectural directive for Lua-extension DLLs, from prior
//! art with actix inside DCS, and card 18's crash is one of the "all sorts of
//! issues" it exists to prevent.
//!
//! So [`ensure_server`] (`jsonrpc.serve`) constructs a [`JsonRpcServer`] and
//! RETURNS it as userdata. Both bridges' boot code parks that userdata in their
//! own state — the hook in its frame callbacks, the mission init in its pump
//! closures — so the server lives exactly as long as the state that asked for
//! it, and no longer: `Drop` stops the listener and takes the actix `System`
//! thread with it, whether it is reached from an explicit mission-end teardown or
//! from `__gc` inside DCS's own `lua_close`. There is **no server static and no
//! queue static**; see [`crate::jsonrpc::teardown`] for the lifecycle and card
//! 18 / issue #69 for the evidence.
//!
//! Every wait on the shutdown path is bounded, because the caller is the sim
//! thread — see [`StopBudget`].

use actix_web::dev::ServerHandle;
use actix_web::error::ErrorInternalServerError;
use actix_web::web::{Data, Json, Payload};
use actix_ws::{Message, Session};

use crate::jsonrpc::router::JsonRpcRouter;
use crate::jsonrpc::{
    JsonRpcError, JsonRpcRequest, JsonRpcResponse, JSON_RPC_BRIDGE_TORN_DOWN,
    JSON_RPC_INTERNAL_ERROR, JSON_RPC_METHOD_NOT_FOUND, JSON_RPC_PUMP_STALLED, JSON_RPC_VERSION,
};
use crate::lua_utils::serialize_lua_to_json;
use actix_web::{get, middleware, post, App, HttpRequest, HttpResponse, HttpServer};
use log::{debug, error, info, warn};
use mlua::prelude::{LuaError, LuaNil, LuaValue};
use mlua::{
    FromLua, IntoLuaMulti, Lua, LuaSerdeExt, MetaMethod, UserData, UserDataMethods, UserDataRef,
    UserDataRefMut,
};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::convert::Infallible;
use std::error::Error;
use std::io;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tokio::runtime::Runtime;
use tokio::sync::oneshot;
use tokio::sync::oneshot::Receiver;
use tokio::task::spawn_local;
use tokio::time::timeout;

const DEFAULT_TIMEOUT: Duration = Duration::from_mins(5);

/// How long [`JsonRpcServer::new`] waits for its server thread to report
/// whether the port bound.
///
/// The caller is the DCS Lua thread — the sim's main loop — so this wait is
/// bounded on purpose: a server thread that wedges before reporting must cost
/// the startup `pcall` an error, not the sim its frame loop forever. Binding a
/// loopback port is microseconds; ten seconds is "something is badly wrong".
const BIND_TIMEOUT: Duration = Duration::from_secs(10);

/// How long this server's queue may go undrained before an arriving request is
/// refused outright rather than queued (card 17). Overridable per server with
/// `pump_stale_ms` in the config; `0` disables the check.
///
/// The number has to sit above the longest gap a *serving* bridge legitimately
/// leaves between drains, and far below the 30 s request deadline it exists to
/// avoid waiting out. The two pumps set the floor: the GUI hook drains once per
/// simulation frame (16 ms at 60 fps, 100 ms at a miserable 10) and the mission
/// state drains per 0.1 s of *model* time. The debugger's pause loop drains every
/// 50 ms through `process_rpc` while it holds the sim thread, so a held breakpoint
/// keeps the bridge the debug engine serves fresh and only the *other* bridge goes
/// stale — which is exactly the split card 17 measured.
///
/// Two seconds is ~20x the slowest healthy drain interval and 15x faster to
/// answer than the deadline. It does mean a multi-second frame hitch — a mission
/// load, a `repl_export` serialising a huge table on the sim thread — reads as
/// stalled; that is why the message says the queue is not being drained rather
/// than claiming the sim is paused. A truthful "not being served right now" in
/// 2 s beats an indistinguishable silence for 30.
const PUMP_STALE_AFTER: Duration = Duration::from_secs(2);

/// The bounded waits one [`JsonRpcServer::stop`] is allowed to spend, and the
/// reason there are two of them.
///
/// Every wait on this path is bounded because the caller is the DCS Lua thread —
/// the sim's main loop. A teardown that blocks the sim trades a crash for a
/// freeze, which is not a trade worth making, so an overrunning stop is left to
/// finish detached and reported rather than waited out.
///
/// `acknowledge` waits for actix to say the server has stopped; `system_exit`
/// then waits for the server's own thread — the one that owns the actix
/// `System` — to leave it and return. The second is the one card 18 cares about:
/// closing the listener is not the same as the worker being gone, and what the
/// evidence indicts is worker/connection state outliving the mission state.
#[derive(Debug, Clone, Copy)]
pub(crate) struct StopBudget {
    acknowledge: Duration,
    system_exit: Duration,
}

/// The budget for a stop the Lua code asked for by name — a mission-end
/// teardown, or `server:stop()`. The state is whole, the sim is between frames,
/// and 2 s is "something is badly wrong" for cutting loopback connections.
pub(crate) const EXPLICIT_STOP: StopBudget = StopBudget {
    acknowledge: Duration::from_secs(2),
    system_exit: Duration::from_secs(2),
};

/// The budget for a stop that `Drop` had to do, which in DCS means `__gc`
/// **inside `lua_close`**: the state is already dying, on the sim thread, and
/// this frame is reached from a C callback. Blocking meaningfully there is the
/// freeze the bounds exist to prevent, so the budget is an order of magnitude
/// tighter than [`EXPLICIT_STOP`] — enough for a non-graceful actix stop of a
/// loopback listener (microseconds in practice), not enough to be felt.
///
/// It only ever gets spent when the primary trigger did not run: after a
/// mission-end teardown the server is already `Stopped` and `Drop` is a no-op.
const COLLECTED_STOP: StopBudget = StopBudget {
    acknowledge: Duration::from_millis(250),
    system_exit: Duration::from_millis(250),
};

/// Take the queue lock, recovering it if a previous holder panicked.
///
/// The same rule as [`crate::locks::with_lock`], for the same reason: a
/// poisoned `Mutex` stays poisoned for the life of the process, so propagating
/// the poison here would brick the bridge for the rest of the DCS session —
/// every request 500ing, `/health` unanswerable, the editor unable to
/// reconnect. Nothing behind this lock can be left half-updated in a way that
/// matters: a request queue, a timeout, and a service identity.
fn lock_app_data(data: &Mutex<AppData>) -> std::sync::MutexGuard<'_, AppData> {
    data.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(crate) struct AppRequest {
    pub(crate) request: JsonRpcRequest,
    pub(crate) response_sender: Option<oneshot::Sender<JsonRpcResponse>>,
}

pub(crate) struct AppData {
    pub(crate) rpc_queue: VecDeque<AppRequest>,
    pub(crate) timeout: Duration,
    pub(crate) service: ServiceInfo,
    /// When the Lua-side pump last drained this queue — stamped by
    /// [`drain_queue`], the one funnel every pump goes through: the hook's frame
    /// callback, the mission state's model-time timer, and the debug engine's
    /// `DBG.pump`, all of which reach it through `process_rpc` on the server
    /// userdata their own state holds. Seeded at bind, so a bridge gets its
    /// [`AppData::pump_stale_after`] worth of grace to start pumping.
    pub(crate) last_drained: Instant,
    /// How stale that stamp may get before an arriving request is refused
    /// instead of queued. `None` disables the check.
    pub(crate) pump_stale_after: Option<Duration>,
}

/// Identity reported by `/health` and `rpc.discover`, so an agent probing
/// 25569/25570 can tell the two bridges apart. `host`/`port` populate the
/// `OpenRPC` `servers` block `rpc.discover` returns.
#[derive(Debug, Clone)]
pub struct ServiceInfo {
    pub name: String,
    pub env: String,
    pub version: String,
    pub host: String,
    pub port: u16,
}

impl Default for ServiceInfo {
    fn default() -> Self {
        ServiceInfo::new(None, "127.0.0.1", 0)
    }
}

impl ServiceInfo {
    fn new(env: Option<&str>, host: &str, port: u16) -> Self {
        let env = env.unwrap_or("gui").to_string();
        ServiceInfo {
            name: format!("dcs-studio-{env}"),
            env,
            version: env!("CARGO_PKG_VERSION").to_string(),
            host: host.to_string(),
            port,
        }
    }
}

/// The `/health` payload.
///
/// `status`/`name`/`env`/`version` describe the *listener*: this endpoint is
/// answered by the actix worker and needs nothing from Lua, which is why it kept
/// answering in 1-2 ms throughout card 17's held breakpoint while `/rpc` could
/// not be dispatched at all. Reachability is not liveness, so the last two fields
/// report the other half — how long ago the Lua-side pump last drained this
/// server's queue, and whether that is now stale enough that requests are being
/// refused with `-32002` (see [`JSON_RPC_PUMP_STALLED`]).
///
/// This is the single "the pump is alive" signal card 17 and card 04 both asked
/// for: a client that wants to know whether a call will be *served*, rather than
/// merely accepted, reads `pump_stalled` — not `status`, and not the socket's
/// connectedness.
#[derive(Serialize, Deserialize, Debug)]
struct Health {
    name: String,
    env: String,
    status: String,
    version: String,
    /// Milliseconds since the Lua-side pump last drained this server's queue.
    pump_idle_ms: u64,
    /// Whether that idle time has passed the refusal threshold, i.e. whether a
    /// request arriving now would be answered `-32002` rather than dispatched.
    /// Always `false` when the check is disabled.
    pump_stalled: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub(crate) struct ServerConfig {
    host: String,
    port: u16,
    timeout: Option<u64>,
    /// The environment this bridge serves ("gui" / "mission") — names the
    /// service in `/health` and `rpc.discover`.
    env: Option<String>,
    /// How long this server's queue may go undrained before arriving requests are
    /// refused with [`JSON_RPC_PUMP_STALLED`] instead of queued. Absent uses
    /// [`PUMP_STALE_AFTER`]; `0` disables the check, which is what a test wanting
    /// a request to sit undrained in the queue asks for.
    pump_stale_ms: Option<u64>,
}

impl FromLua for ServerConfig {
    fn from_lua(value: LuaValue, lua: &Lua) -> mlua::Result<Self> {
        let value = lua.from_value(value)?;
        serde_json::from_value::<ServerConfig>(value).map_err(LuaError::external)
    }
}

/// A JSON-RPC server owned by the Lua state that asked for it. Handed to Lua as
/// userdata by [`ensure_server`]; stops when that state stops holding it.
pub(crate) struct JsonRpcServer {
    config: ServerConfig,
    /// This server's OWN request queue — no longer reachable through a static.
    /// Whoever holds this userdata can drain it (`process_rpc`) or fail it
    /// ([`JsonRpcServer::fail_queued`]), and nobody else can, which is the point:
    /// a queue no dead state can be reached through.
    app_data: Data<Mutex<AppData>>,
    /// `Serving` or `Stopped`, rather than a `stopped` flag beside a live handle:
    /// a stopped server has no handle and no thread to observe, and the type
    /// says so. Taking the state is what makes every stop idempotent.
    state: ServerState,
}

/// Whether a [`JsonRpcServer`] still has a listener and a thread behind it.
enum ServerState {
    Serving {
        handle: ServerHandle,
        /// Goes `Disconnected` when the server's thread returns — see
        /// [`wait_for_system_exit`]. Nothing is ever sent on it, which is why its
        /// item type is uninhabited: the *end* of the channel is the whole
        /// signal.
        system_exited: mpsc::Receiver<Infallible>,
    },
    Stopped,
}

/// What one [`JsonRpcServer::stop`] managed to do, for the caller's log line.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ServerStop {
    /// The port the stopped server had been serving on.
    pub(crate) port: u16,
    /// Whether the server's thread was observed to leave its actix `System`
    /// within the budget. `false` means the stop was left running detached
    /// rather than blocking the sim thread — the honest answer, and the one a
    /// live session needs to see in the log.
    pub(crate) system_exited: bool,
}

impl AppData {
    /// Test-only: the production path is [`AppData::with_stale_after`], which
    /// takes the threshold from the server's config.
    #[cfg(test)]
    fn new(timeout: Duration, service: ServiceInfo) -> Self {
        AppData::with_stale_after(timeout, service, Some(PUMP_STALE_AFTER))
    }

    fn with_stale_after(
        timeout: Duration,
        service: ServiceInfo,
        pump_stale_after: Option<Duration>,
    ) -> Self {
        AppData {
            rpc_queue: VecDeque::new(),
            timeout,
            service,
            last_drained: Instant::now(),
            pump_stale_after,
        }
    }

    /// Record that the Lua-side pump just ran.
    fn mark_drained(&mut self) {
        self.last_drained = Instant::now();
    }

    /// How long the pump has been idle.
    fn pump_idle(&self) -> Duration {
        self.last_drained.elapsed()
    }

    /// How long the pump has been idle, but only when that is long enough to say
    /// a request arriving now would never be dispatched — `None` while the pump
    /// is fresh, and always `None` when the check is disabled.
    fn pump_stall(&self) -> Option<Duration> {
        let after = self.pump_stale_after?;
        let idle = self.pump_idle();
        (idle >= after).then_some(idle)
    }
}

impl JsonRpcServer {
    /// Bind the port and start serving, or fail with the reason.
    ///
    /// The whole of the server's construction — `HttpServer::new`, `bind` and
    /// `run` — happens on the thread that owns the actix `System`, and the bind
    /// outcome travels back to the caller over a channel. Two reasons, both
    /// learned the hard way (card 20):
    ///
    /// 1. `HttpServer::run` is documented to panic without a Tokio runtime, and
    ///    the caller is the DCS Lua thread, which has none. The returned
    ///    `Server` is also inert until polled, so creating it here and polling
    ///    it there made the listener's survival depend on what happened to the
    ///    future in between — and what happened was that the only `.await` on
    ///    it sat inside an `info!` argument, which `log` does not evaluate at
    ///    the shipped `warn` level. The bridge bound a port, reported success,
    ///    dropped the unpolled future, and refused every connection.
    /// 2. A genuine bind failure must still reach Lua as an error. Moving the
    ///    bind off the caller would otherwise turn "the port is taken" into a
    ///    silent success, which is the same failure mode wearing a different
    ///    hat.
    pub(crate) fn new(config: ServerConfig) -> Result<Self, actix_web::Error> {
        let service = ServiceInfo::new(config.env.as_deref(), &config.host, config.port);
        let app_data = Data::new(Mutex::new(AppData::with_stale_after(
            get_timeout_duration_from_config(&config),
            service,
            get_pump_stale_after_from_config(&config),
        )));
        let app_data_2 = app_data.clone();

        let host = config.host.clone();
        let port = config.port;

        // Build, bind AND run the server on the thread that owns the runtime,
        // and report the bind outcome back over a channel. See `BIND_TIMEOUT`
        // and the module note on why none of this may happen on the caller.
        let (outcome_tx, outcome_rx) = mpsc::sync_channel::<Result<ServerHandle, io::Error>>(1);
        // The other end goes Disconnected when this closure returns, whether it
        // returns normally or by unwinding — either way the `System` is done with.
        let (exit_tx, system_exited) = mpsc::channel::<Infallible>();
        thread::Builder::new()
            .name(format!("dcs-studio-jsonrpc-{port}"))
            .spawn(move || {
                let _exit_signal = exit_tx;
                actix_web::rt::System::new().block_on(async move {
                    let bound = HttpServer::new(move || {
                        App::new()
                            .wrap(middleware::Logger::default())
                            .service(get_ws)
                            .service(get_health)
                            .service(post_rpc)
                            .app_data(Data::clone(&app_data_2))
                    })
                    .workers(1)
                    .bind((host, port));

                    let server = match bound {
                        Ok(bound) => bound.run(),
                        Err(cause) => {
                            let _ = outcome_tx.send(Err(cause));
                            return;
                        }
                    };

                    // A caller that already gave up (see `BIND_TIMEOUT`) has no
                    // way to stop this server, so don't start one: dropping the
                    // future here releases the listener rather than leaving a
                    // port bound to nothing for the rest of the DCS session.
                    if outcome_tx.send(Ok(server.handle())).is_err() {
                        warn!("jsonrpc: nobody left to serve for, releasing {port}");
                        return;
                    }

                    // The `Server` future does NOTHING until it is polled, and
                    // this await is the only thing that ever polls it. It must
                    // stay a statement in its own right — computing the outcome
                    // first and logging it after, never inside a log macro's
                    // arguments (card 20).
                    let finished = server.await;
                    info!("Server run finished: {finished:?}");
                });
            })?;

        let handle = match outcome_rx.recv_timeout(BIND_TIMEOUT) {
            Ok(outcome) => outcome?,
            // The thread neither bound nor failed within the budget. Waiting
            // longer is not an option — the caller is the sim thread.
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Close the channel BEFORE anything else. A `send` landing in
                // the window between the timeout and this scope's end would
                // otherwise succeed, so the thread's "nobody left to serve for"
                // release would never fire and it would serve forever on a
                // handle no one can reach — the exact leak the timeout exists
                // to avoid. Dropping the receiver first makes that late send
                // fail by construction.
                drop(outcome_rx);
                return Err(ErrorInternalServerError(format!(
                    "jsonrpc.serve: the server thread did not report a bind result for {}:{port} \
                     within {BIND_TIMEOUT:?}",
                    config.host
                )));
            }
            // The sender was dropped without sending: the server thread died,
            // and a panic there would otherwise be swallowed silently.
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(ErrorInternalServerError(format!(
                    "jsonrpc.serve: the server thread for {}:{port} died before it could bind",
                    config.host
                )));
            }
        };

        Ok(Self {
            config,
            app_data,
            state: ServerState::Serving {
                handle,
                system_exited,
            },
        })
    }

    /// Whether this server belongs to the mission bridge — the only one whose
    /// Lua state DCS destroys mid-process, and so the only one an explicit
    /// teardown stops. See [`crate::jsonrpc::teardown`] for why the two bridges
    /// differ.
    pub(crate) fn serves_mission_state(&self) -> bool {
        self.config.env.as_deref() == Some("mission")
    }

    /// Fail every request stranded in THIS server's queue, telling each caller
    /// `reason`. Returns how many callers were actually told (a caller that had
    /// already given up, and a notification, have nobody to tell).
    ///
    /// **Touches no Lua**, which is what makes it callable from `Drop` while
    /// `lua_close` is running: a queue entry is a serde [`JsonRpcRequest`] and a
    /// `oneshot` sender, and the response is built from a string. The Lua state
    /// that would have answered these requests is going away or already gone, so
    /// the honest outcome is an error naming that — not a silent drop the caller
    /// reads as a closed channel, and not the server timeout it would otherwise
    /// wait out.
    pub(crate) fn fail_queued(&self, reason: &str) -> usize {
        let queue = std::mem::take(&mut lock_app_data(&self.app_data).rpc_queue);

        // A plain loop rather than a chain: each entry has to be consumed to
        // move its sender out, and the only interesting outcome is the side
        // effect.
        let mut told = 0;
        for app_request in queue {
            // A notification has no id and no channel — nowhere to report to. A
            // `send` that fails means the caller already gave up, which is
            // likewise nothing to report.
            if let (Some(sender), Some(id)) = (app_request.response_sender, app_request.request.id)
            {
                if sender.send(torn_down_response(id, reason)).is_ok() {
                    told += 1;
                }
            }
        }
        told
    }

    /// Stop this server and wait, within `budget`, for its thread to leave its
    /// actix `System`. `None` when it had already stopped.
    ///
    /// Idempotent by construction — the state is *taken*, so there is no second
    /// handle to stop — and infallible on purpose: `Drop` is one of the callers.
    ///
    /// **Immediate, not graceful.** A graceful stop waits for open connections
    /// to finish, and the editor holds a WebSocket open for the whole session
    /// plus a poll every 2 s — exactly the connections whose survival across the
    /// unload card 18 indicts. Waiting on them would be waiting on the client,
    /// on the sim thread, mid-teardown. So the connections are cut.
    pub(crate) fn stop(&mut self, budget: StopBudget) -> Option<ServerStop> {
        let ServerState::Serving {
            handle,
            system_exited,
        } = std::mem::replace(&mut self.state, ServerState::Stopped)
        else {
            return None;
        };
        let port = self.config.port;
        stop_on_thread(handle, budget);
        Some(ServerStop {
            port,
            system_exited: wait_for_system_exit(port, &system_exited, budget),
        })
    }
}

/// Bind a server and hand it to Lua — exposed as `jsonrpc.serve(config)`, which
/// both bridges' boot code calls. The mission DLL calls it from its embedded init
/// on EVERY mission load, into a fresh Lua state each time.
///
/// The returned server is **owned by the Lua state that asked for it** (see the
/// module docs): there is no DLL-wide slot to reuse, so every mission binds its
/// own listener with its own worker and its own connections, and the previous
/// mission's are gone with the previous mission's state. A mission whose port is
/// somehow still held gets a bind error its init reports, rather than silently
/// inheriting a stranger's server.
pub(crate) fn ensure_server(config: ServerConfig) -> Result<JsonRpcServer, actix_web::Error> {
    JsonRpcServer::new(config)
}

/// Stop the server from a dedicated thread, waiting at most
/// `budget.acknowledge` for it to finish. `ServerHandle::stop` is async and
/// `block_on` must never run on the caller: blocking inside a tokio runtime
/// would panic, and the caller here is the DCS Lua thread, which has no runtime
/// at all.
///
/// The stop thread is deliberately **not** joined. This runs from the sim thread
/// during mission teardown — and from `__gc` inside `lua_close` — where an
/// unbounded join would turn a crash into a freeze; if the stop overruns the
/// budget it is left to finish detached, which costs a thread and nothing else.
///
/// Infallible on purpose. The only ways this can go wrong are the OS refusing a
/// thread and tokio refusing a runtime, neither of which a caller could act on —
/// and one of the callers is `Drop`, where a failure would have to become a
/// panic. A panic while unwinding aborts the process, and inside DCS that takes
/// the sim down. The outcome is logged instead.
fn stop_on_thread(handle: ServerHandle, budget: StopBudget) {
    let (done_tx, done_rx) = mpsc::sync_channel::<()>(1);
    if let Err(cause) = thread::Builder::new()
        .name("dcs-studio-jsonrpc-stop".to_string())
        .spawn(move || {
            let outcome = Runtime::new().map(|runtime| runtime.block_on(handle.stop(false)));
            info!("Server stop thread finished: {outcome:?}");
            // The receiver may already be gone (see the timeout arm below);
            // there is then nobody to tell, which is not a failure.
            let _ = done_tx.send(());
        })
    {
        error!("jsonrpc: could not spawn a thread to stop the server: {cause}");
        return;
    }

    match done_rx.recv_timeout(budget.acknowledge) {
        Ok(()) => info!("Server stop acknowledged"),
        Err(cause) => warn!(
            "jsonrpc: the server did not stop within {:?} ({cause}); leaving the \
             stop to finish detached rather than blocking the caller",
            budget.acknowledge
        ),
    }
}

/// Wait, within `budget`, for a stopped server's thread to leave its actix
/// `System`.
///
/// Nothing is ever sent on this channel: the sender lives in the server thread's
/// closure, so the channel disconnecting IS the thread returning — its `System`
/// shut down, its worker gone. That is the half of "stopped" that
/// [`ServerHandle::stop`] alone does not promise, and the half card 18 cares
/// about.
fn wait_for_system_exit(
    port: u16,
    system_exited: &mpsc::Receiver<Infallible>,
    budget: StopBudget,
) -> bool {
    match system_exited.recv_timeout(budget.system_exit) {
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            info!("jsonrpc: the server thread for port {port} has exited");
            true
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            warn!(
                "jsonrpc: the server thread for port {port} had not exited after {:?}; \
                 not waiting any longer — a blocked caller here is the sim thread",
                budget.system_exit
            );
            false
        }
        // Uninhabited: there is no value of `Infallible` to have received.
        Ok(never) => match never {},
    }
}

impl Drop for JsonRpcServer {
    /// The guarantee the whole design rests on: when the Lua state stops holding
    /// this userdata, the server stops. In DCS that means `__gc` **inside
    /// `lua_close`** for a mission that never fired its end event — so this frame
    /// touches no Lua, spends only the tight [`COLLECTED_STOP`] budget, and must
    /// never panic: a panic in `Drop` during unwinding aborts the process, and
    /// inside DCS an abort is the sim closing itself.
    ///
    /// A no-op for the server half when the state ran its teardown first, which
    /// is the normal path — the state is `Stopped` by then.
    fn drop(&mut self) {
        // The discarded `Err` is the point: there is nowhere left to report to.
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let failed = self.fail_queued(crate::jsonrpc::teardown::STATE_GONE);
            match self.stop(COLLECTED_STOP) {
                Some(stop) => info!(
                    "jsonrpc: the server on port {} was collected with its Lua state \
                     — stopped it (thread exited: {}) and failed {failed} queued \
                     request(s)",
                    stop.port, stop.system_exited
                ),
                None => debug!(
                    "jsonrpc: dropping the already-stopped server on port {} \
                     (failed {failed} queued request(s))",
                    self.config.port
                ),
            }
        }));
    }
}

impl UserData for JsonRpcServer {
    fn add_methods<'lua, M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_function("new", |_lua: &Lua, config: ServerConfig| {
            JsonRpcServer::new(config).map_err(LuaError::external)
        });

        methods.add_meta_method(MetaMethod::ToString, |_, this: &Self, ()| {
            Ok(format!("JsonRpcServer({:?})", this.config))
        });

        methods.add_method(
            "process_rpc",
            |lua: &Lua, this: &JsonRpcServer, router: UserDataRef<JsonRpcRouter>| {
                drain_queue(lua, &this.app_data, &router);
                true.into_lua_multi(lua)
            },
        );

        methods.add_method_mut("stop", |lua: &Lua, this: &mut JsonRpcServer, ()| match this
            .stop(EXPLICIT_STOP)
        {
            Some(stop) => (true, stop.system_exited).into_lua_multi(lua),
            None => (false, true).into_lua_multi(lua),
        });

        // The mission bridge's end-of-life, in the order live verification
        // pinned: handlers, then the queue's -32001s, then the listener.
        methods.add_method_mut(
            "teardown",
            |lua: &Lua,
             this: &mut JsonRpcServer,
             (mut router, reason): (UserDataRefMut<JsonRpcRouter>, Option<String>)| {
                let reason = reason.unwrap_or_else(|| "requested".to_string());
                crate::jsonrpc::teardown::release(this, &mut router, &reason).into_lua_multi(lua)
            },
        );
    }
}

/// Swap the queue out under the lock, then run the Lua handlers unlocked: a
/// slow eval must not block the WS/HTTP tasks that are queueing new requests.
///
/// This is the single funnel every pump goes through — the hook's
/// `onSimulationFrame`, the mission state's model-time timer, and the debug
/// engine's `DBG.pump`, all of them `process_rpc` on the server userdata their
/// own state holds — so it is where the "the pump is alive" stamp belongs (card
/// 17). Stamped whether or not there was anything to drain: an empty queue
/// drained is still a pump that ran. Stamped again afterwards so a drain that
/// spent tens of seconds inside one handler does not leave the bridge looking
/// stalled the instant it finishes.
fn drain_queue(lua: &Lua, app_data: &Data<Mutex<AppData>>, router: &JsonRpcRouter) {
    let (queue, service) = {
        let mut data_guard = lock_app_data(app_data);
        data_guard.mark_drained();
        (
            std::mem::take(&mut data_guard.rpc_queue),
            data_guard.service.clone(),
        )
    };

    for app_request in queue {
        respond(lua, router, app_request, &service);
    }

    lock_app_data(app_data).mark_drained();
}

/// The envelope a caller gets when the Lua state that would have answered it is
/// being destroyed.
fn torn_down_response(id: String, reason: &str) -> JsonRpcResponse {
    JsonRpcResponse {
        jsonrpc: JSON_RPC_VERSION.to_string(),
        id,
        result: None,
        error: serde_json::to_value(JsonRpcError {
            code: JSON_RPC_BRIDGE_TORN_DOWN,
            message: "bridge torn down".to_string(),
            data: serde_json::to_value(reason).ok(),
        })
        .ok(),
    }
}

/// A loopback port nothing is listening on: bind one, read its number, let it
/// go. Racy in principle, fine in a serialized test.
#[cfg(test)]
#[allow(clippy::expect_used)] // test scaffolding
pub(crate) fn free_port() -> u16 {
    let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("probe");
    probe.local_addr().expect("addr").port()
}

/// Ask a bound bridge for `/health` over a raw socket and return the whole HTTP
/// response. No client dependency, and it proves the server is *serving* rather
/// than merely bound — which is also what makes it the instrument for the
/// opposite assertion: after a mission-end stop, connecting must fail.
#[cfg(test)]
pub(crate) fn health_over_tcp(port: u16) -> std::io::Result<String> {
    use std::io::{Read, Write};

    let mut socket = std::net::TcpStream::connect(("127.0.0.1", port))?;
    socket.set_read_timeout(Some(Duration::from_secs(10)))?;
    socket.write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
    let mut answer = String::new();
    socket.read_to_string(&mut answer)?;
    Ok(answer)
}

/// Queue `request` against a server as its HTTP/WS handlers do, returning the
/// channel a caller would await. Lets the crate's own tests drive the mission
/// lifecycle — where the interesting moment is a request the sim never drains.
#[cfg(test)]
pub(crate) fn queue_against(
    server: &JsonRpcServer,
    request: JsonRpcRequest,
) -> Option<Receiver<JsonRpcResponse>> {
    let mut guard = lock_app_data(&server.app_data);
    push_rpc_request(&mut guard, request)
}

/// What offering a request to the queue produced.
enum Queued {
    /// Queued, and something is expected to answer it: await this channel.
    Waiting(Receiver<JsonRpcResponse>),
    /// Queued as a notification — no id, so there is nothing to await.
    Accepted,
    /// NOT queued. The Lua-side pump has not drained for long enough that
    /// nothing would have answered it, so here is that answer instead — now,
    /// rather than after the request deadline (card 17).
    PumpStalled(Box<JsonRpcResponse>),
}

/// Offer `request` to the queue, refusing it outright when the pump is stale.
///
/// The refusal is deliberately limited to requests carrying an id. A
/// notification has no caller waiting and no deadline to burn, so queueing it is
/// free and its side effect still runs on the frame the sim resumes.
fn accept_request(data: &mut AppData, request: JsonRpcRequest) -> Queued {
    if let (Some(idle), Some(id)) = (data.pump_stall(), request.id.clone()) {
        warn!(
            "jsonrpc: refusing '{}' [{id}] - the {} bridge's queue has not been drained \
             for {idle:?}",
            request.method, data.service.env
        );
        let response = pump_stalled_response(id, &data.service, idle);
        return Queued::PumpStalled(Box::new(response));
    }
    match push_rpc_request(data, request) {
        Some(receiver) => Queued::Waiting(receiver),
        None => Queued::Accepted,
    }
}

/// The envelope a caller gets when the transport is healthy but nothing is
/// draining the queue.
///
/// The `data` string names the observable fact — the queue is not being drained,
/// and for how long — rather than asserting a cause. The causes it covers are not
/// distinguishable from here and not all of them are a pause: a held breakpoint
/// in the other bridge's state, a paused sim, a mission sitting on the briefing
/// screen with model time frozen (card 04's residual), a mission load, or a
/// handler that has owned the sim thread for seconds. What the editor needs to
/// know is the same in every case: not now, but nothing is broken.
fn pump_stalled_response(id: String, service: &ServiceInfo, idle: Duration) -> JsonRpcResponse {
    let detail = format!(
        "the {} bridge's queue has not been drained for {} ms - DCS is not running \
         the pump that dispatches requests into Lua (the sim is paused, loading, or \
         a debug session or long call holds the sim thread). The bridge is listening \
         and will serve again as soon as it is pumped.",
        service.env,
        idle.as_millis()
    );
    JsonRpcResponse {
        jsonrpc: JSON_RPC_VERSION.to_string(),
        id,
        result: None,
        error: serde_json::to_value(JsonRpcError {
            code: JSON_RPC_PUMP_STALLED,
            message: "sim not pumping".to_string(),
            data: serde_json::to_value(detail).ok(),
        })
        .ok(),
    }
}

#[post("/rpc")]
async fn post_rpc(
    _req: HttpRequest,
    data: Data<Mutex<AppData>>,
    body: Json<JsonRpcRequest>,
) -> Result<HttpResponse, actix_web::Error> {
    let request = body.into_inner();

    // Hold the std Mutex only to enqueue the request and read the timeout, in a
    // block that ends before any `.await` — a guard must never span an await
    // point (it would block the executor / risk a deadlock inside the sim).
    let (queued, request_timeout) = {
        let mut data_guard = lock_app_data(&data);
        let queued = accept_request(&mut data_guard, request);
        (queued, data_guard.timeout)
    };

    let receiver = match queued {
        Queued::Waiting(receiver) => receiver,
        Queued::Accepted => return Ok(HttpResponse::Accepted().body("OK")),
        // A JSON-RPC error is still a delivered answer, so 200 with the envelope
        // — exactly as an error from a handler is returned below.
        Queued::PumpStalled(response) => {
            let body = serde_json::to_string(&response).map_err(ErrorInternalServerError)?;
            return Ok(HttpResponse::Ok().body(body));
        }
    };

    let result = timeout(request_timeout, receiver).await.map_err(|_| {
        ErrorInternalServerError(format!("Timed out max: {request_timeout:?} seconds"))
    })?;

    let response = result.map_err(ErrorInternalServerError)?;

    let body = serde_json::to_string(&response).map_err(ErrorInternalServerError)?;

    Ok(HttpResponse::Ok().body(body))
}

#[get("/ws")]
async fn get_ws(
    req: HttpRequest,
    body: Payload,
    data: Data<Mutex<AppData>>,
) -> actix_web::Result<HttpResponse> {
    let (response, mut session, mut msg_stream) = actix_ws::handle(&req, body)?;

    info!("WebSocket connection established");

    spawn_local(async move {
        while let Some(Ok(msg)) = msg_stream.recv().await {
            match msg {
                Message::Text(text) => {
                    // Enqueue the request IN ORDER (synchronously) but await its
                    // response in a DETACHED task, so a long-running request does
                    // not head-of-line-block reads of later frames on this
                    // connection. The debugger depends on this: `debug_run`
                    // blocks bridge-side for the whole session (the sim thread's
                    // pump serves the editor's polls from inside it), and if the
                    // read loop awaited its response before reading the next
                    // frame, the very `debug_state` polls that surface the first
                    // breakpoint — and every step/continue after it — would sit
                    // unread in the socket until `debug_run`'s server-side
                    // timeout fired. See notify_session; matching by id keeps
                    // out-of-order responses correct.
                    match enqueue_text_frame(&text, &data) {
                        Some((Queued::Waiting(receiver), request_timeout)) => {
                            let session = session.clone();
                            spawn_local(async move {
                                notify_session(session, receiver, request_timeout)
                                    .await
                                    .unwrap_or_else(|e| error!("{e}"));
                            });
                        }
                        // Answered here rather than in a detached task: the
                        // answer already exists, and writing it in the read loop
                        // keeps it ahead of any later frame's reply (card 17).
                        Some((Queued::PumpStalled(response), _)) => {
                            match serde_json::to_string(&response) {
                                Ok(body) => {
                                    if let Err(cause) = session.text(body).await {
                                        error!("could not report a stalled pump: {cause}");
                                    }
                                }
                                Err(cause) => error!("could not encode the refusal: {cause}"),
                            }
                        }
                        // A notification, or a frame that was not a request at
                        // all: nothing to await and nothing to answer.
                        Some((Queued::Accepted, _)) | None => {}
                    }
                }
                Message::Ping(bytes) => {
                    // A pong that cannot be written means the peer is already
                    // gone; the next read ends this loop, so there is nothing
                    // to recover and nothing to decide.
                    let pong = session.pong(&bytes).await;
                    debug!("Ponged a keepalive: {pong:?}");
                }
                Message::Close(reason) => {
                    let _ = session.close(reason).await;
                    break;
                }
                _ => break,
            }
        }
    });

    Ok(response)
}

/// Parse one WS text frame and offer it to the queue, returning what that
/// produced plus the request timeout — or `None` for a malformed frame. The
/// enqueue is synchronous so frames keep their arrival order in the queue; only
/// the wait-and-reply is deferred. A malformed frame (bad JSON, numeric id, …) is
/// logged and skipped, never fatal: the session must survive one bad client
/// frame.
fn enqueue_text_frame(message: &str, data: &Data<Mutex<AppData>>) -> Option<(Queued, Duration)> {
    let Ok(request) = serde_json::from_str::<JsonRpcRequest>(message) else {
        error!("Failed to parse request, skipping frame: {message}");
        return None;
    };

    let mut data_guard = lock_app_data(data);
    let queued = accept_request(&mut data_guard, request);
    Some((queued, data_guard.timeout))
}

#[get("/health")]
async fn get_health(data: Data<Mutex<AppData>>) -> Json<Health> {
    let (service, pump_idle, pump_stalled) = {
        let guard = lock_app_data(&data);
        (
            guard.service.clone(),
            guard.pump_idle(),
            guard.pump_stall().is_some(),
        )
    };
    Json(Health {
        name: service.name,
        env: service.env,
        status: "OK".to_string(),
        version: service.version,
        // Saturating because this is a report, not a computation: a `u64` of
        // milliseconds is ~584 million years, but a clock that ever hands back
        // something absurd must not cost the only endpoint that still works when
        // the sim is wedged.
        pump_idle_ms: u64::try_from(pump_idle.as_millis()).unwrap_or(u64::MAX),
        pump_stalled,
    })
}

/// Process one queued request and push its response (if any) back over the
/// requester's channel. Failures are logged — one bad request must not stop
/// the drain.
fn respond(lua: &Lua, router: &JsonRpcRouter, app_request: AppRequest, service: &ServiceInfo) {
    match process_request(lua, router, app_request.request, service) {
        Ok(Some(response)) => {
            // At `debug`, not `info`: this is the whole response BODY, written
            // on the sim thread into a file that never rolls. A paused debug
            // session polls `debug_state` four times a second and every answer
            // carries the entire pause snapshot.
            debug!("Sending response: {response:?}");
            match app_request.response_sender {
                Some(sender) => {
                    if sender.send(response).is_err() {
                        error!("Failed to send response");
                    }
                }
                None => debug!("Processed notification: {response:?}"),
            }
        }
        // A notification and a request that could not be processed at all are
        // the same thing from here: there is nothing to push back, and neither
        // may stop the drain — the sim runs this loop once per frame.
        outcome => info!("No response to send: {outcome:?}"),
    }
}

/// A JSON-RPC success envelope carrying an already-built result value.
fn success_response(id: String, result: serde_json::Value) -> JsonRpcResponse {
    JsonRpcResponse {
        jsonrpc: JSON_RPC_VERSION.to_string(),
        id,
        result: Some(result),
        error: None,
    }
}

/// Build the response envelope for a handler's `result`. A result the
/// serializer can't represent — a cyclic table past the depth cap, a function,
/// … — becomes a JSON-RPC error carrying the real cause, not a resultless
/// response the editor can't interpret, and never a panic that would take the
/// sim down.
fn response_for(id: String, result: &LuaValue) -> JsonRpcResponse {
    match serialize_lua_to_json(result) {
        Ok(value) => success_response(id, value),
        Err(cause) => JsonRpcResponse {
            jsonrpc: JSON_RPC_VERSION.to_string(),
            id,
            result: None,
            error: serde_json::to_value(JsonRpcError {
                code: JSON_RPC_INTERNAL_ERROR,
                message: "result not serializable".to_string(),
                data: serde_json::to_value(cause).ok(),
            })
            .ok(),
        },
    }
}

fn error_response(
    id: String,
    code: i32,
    message: String,
    data: Option<serde_json::Value>,
) -> Result<JsonRpcResponse, LuaError> {
    let error = JsonRpcError {
        code,
        message,
        data,
    };
    Ok(JsonRpcResponse {
        jsonrpc: JSON_RPC_VERSION.to_string(),
        id,
        result: None,
        error: Some(serde_json::to_value(error).map_err(LuaError::external)?),
    })
}

fn process_request(
    lua: &Lua,
    router: &JsonRpcRouter,
    request: JsonRpcRequest,
    service: &ServiceInfo,
) -> Result<Option<JsonRpcResponse>, LuaError> {
    debug!("Processing RPC request: {request:?}");

    // `rpc.discover` is answered by the server itself, before the router
    // lookup — every bridge (and every transport: POST /rpc and WS alike)
    // gets the OpenRPC document for free. Per the OpenRPC spec, rpc.discover
    // returns the service's OpenRPC description, generated here from the exact
    // methods the router registered.
    if request.method == "rpc.discover" {
        let Some(id) = request.id else {
            return Ok(None);
        };
        let result = crate::jsonrpc::openrpc::build_document(
            &service.name,
            &service.version,
            &service.env,
            &service.host,
            service.port,
            &router.methods_sorted(),
        );
        return Ok(Some(success_response(id, result)));
    }

    let method_name = request.method.clone();

    debug!("Getting method: {method_name:?}");
    let Some(method) = router.get_method(&request.method) else {
        warn!("Method not found!");
        let Some(id) = request.id else {
            return Ok(None);
        };
        let message = format!("Method not found: {method_name}");
        return error_response(id, JSON_RPC_METHOD_NOT_FOUND, message, None).map(Some);
    };

    debug!("Method found, mapping parameters: {:?}", request.params);
    let params: LuaValue = match request.params {
        Some(params) => lua.to_value(&params).map_err(LuaError::external)?,
        None => LuaNil,
    };

    debug!("Calling Lua method with params: {method:?}, {params:?}");

    // Run the handler now — its side effects must apply even to a notification —
    // and log the outcome, then let the single id guard below drop the response
    // for a notification (no id) rather than repeating the guard per arm.
    let outcome = method.call::<LuaValue>(params);
    match &outcome {
        Ok(result) => debug!("Method call successful, result: {result:?}"),
        Err(e) => error!("Method call failed: {e}"),
    }
    let Some(id) = request.id else {
        return Ok(None);
    };

    match outcome {
        Ok(result) => Ok(Some(response_for(id, &result))),
        Err(e) => {
            // Strip the Lua stack traceback: the editor only needs the message.
            let msg = e.to_string();
            let msg = msg.split("\nstack traceback:").next().unwrap_or(&msg);
            let data = serde_json::to_value(msg).map_err(LuaError::external)?;

            error_response(
                id,
                JSON_RPC_INTERNAL_ERROR,
                "LuaError".to_string(),
                Some(data),
            )
            .map(Some)
        }
    }
}

fn push_rpc_request(
    data: &mut AppData,
    request: JsonRpcRequest,
) -> Option<Receiver<JsonRpcResponse>> {
    let request_id = &request.id;

    info!(
        "<< [{}]: '{:?}'",
        request_id.as_deref().unwrap_or("notification"),
        request
    );

    if let Some(id) = request_id {
        debug!("Adding request to queue with id: {id}");
        let (sender, receiver) = oneshot::channel::<JsonRpcResponse>();
        data.rpc_queue.push_back(AppRequest {
            request,
            response_sender: Some(sender),
        });
        Some(receiver)
    } else {
        debug!("Adding notification to queue");
        data.rpc_queue.push_back(AppRequest {
            request,
            response_sender: None,
        });
        None
    }
}

/// Await one queued request's response and write it back over `session`.
///
/// Every failure here is a normal end to a request, not a bug: the sim never
/// drained the queue in time, the queue was swapped out from under the caller
/// by a mission reload, or the editor closed the socket first. `?` over
/// `Box<dyn Error>` keeps them on one path, and `get_ws` logs whichever one
/// happened — one dead request must never take the session down with it.
async fn notify_session(
    mut session: Session,
    receiver: Receiver<JsonRpcResponse>,
    timeout_duration: Duration,
) -> Result<(), Box<dyn Error>> {
    let response = timeout(timeout_duration, receiver).await??;
    session.text(serde_json::to_string(&response)?).await?;
    Ok(())
}

fn get_timeout_duration_from_config(config: &ServerConfig) -> Duration {
    match config.timeout {
        Some(configured_timeout) => {
            if configured_timeout == 0 {
                warn!("Timeout is set to 0, using infinite timeout, this is NOT recommended.");
                Duration::from_secs(u64::MAX)
            } else {
                Duration::from_secs(configured_timeout)
            }
        }
        None => DEFAULT_TIMEOUT,
    }
}

/// The configured pump-staleness threshold, or [`PUMP_STALE_AFTER`] when the
/// config is silent. An explicit `0` disables the check: the request queues and
/// waits out the request timeout, which is the pre-card-17 behaviour and the one
/// a test that wants a request left undrained needs.
fn get_pump_stale_after_from_config(config: &ServerConfig) -> Option<Duration> {
    match config.pump_stale_ms {
        Some(0) => {
            warn!(
                "jsonrpc: pump_stale_ms = 0 - requests arriving while the sim is not \
                 draining will wait out the request timeout instead of failing fast"
            );
            None
        }
        Some(millis) => Some(Duration::from_millis(millis)),
        None => Some(PUMP_STALE_AFTER),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod tests {
    use super::{
        accept_request, drain_queue, enqueue_text_frame, error_response, free_port, get_health,
        get_pump_stale_after_from_config, get_timeout_duration_from_config, health_over_tcp,
        lock_app_data, post_rpc, process_request, push_rpc_request, respond, response_for,
        success_response, AppData, AppRequest, JsonRpcServer, Queued, ServerConfig, ServiceInfo,
        DEFAULT_TIMEOUT, JSON_RPC_INTERNAL_ERROR, JSON_RPC_METHOD_NOT_FOUND, JSON_RPC_PUMP_STALLED,
        JSON_RPC_VERSION, PUMP_STALE_AFTER,
    };
    use crate::jsonrpc::router::{JsonRpcRouter, MethodMeta};
    use crate::jsonrpc::{JsonRpcRequest, JsonRpcResponse};
    use actix_web::web::Data;
    use mlua::Lua;
    use std::sync::Mutex;
    use std::time::Duration;

    fn config(json: &str) -> ServerConfig {
        serde_json::from_str(json).expect("config")
    }

    /// **Card 20.** A `Server` future does nothing until something polls it, and
    /// the only thing that ever polled this one was the argument of
    /// `info!("Server run finished: {:?}", server.await)`. `log`'s macros do not
    /// evaluate their arguments when the level is disabled, so at the shipped
    /// `warn` level that `await` simply never happened: the future was dropped
    /// unpolled and took the freshly bound listener with it, while `new()` had
    /// already returned `Ok`. Hence a bridge that logged itself serving and
    /// refused every connection.
    ///
    /// The level is pinned to `Warn` here deliberately — that is the shipped
    /// one, and it must not be the difference between a working bridge and a
    /// dead port.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn the_bound_listener_serves_at_the_shipped_warn_log_level() {
        let _serial = crate::jsonrpc::serially();
        let restore_level = log::max_level();
        log::set_max_level(log::LevelFilter::Warn);

        let port = free_port();
        let server = JsonRpcServer::new(config(&format!(
            r#"{{"host":"127.0.0.1","port":{port},"env":"gui"}}"#
        )))
        .expect("a free port binds");

        let answer = health_over_tcp(port);
        drop(server);
        log::set_max_level(restore_level);

        let answer = answer.expect("the listener must still exist at warn");
        assert!(answer.contains("200 OK"), "{answer}");
        assert!(answer.contains("dcs-studio-gui"), "{answer}");
    }

    /// **Card 18.** Stopping the mission bridge's server has to take the whole
    /// serving apparatus with it, not just make it idle: the crash follows an
    /// actix worker that had accepted connections during the mission and then
    /// outlived the mission state, so both halves are asserted — the listener is
    /// gone (a connect is refused, which is exactly what would still SUCCEED
    /// without the stop) and the thread that owned the `System` has left it.
    ///
    /// Then the same port binds again, because the mission after this one has to
    /// get a bridge.
    #[test]
    fn stopping_the_mission_server_takes_its_listener_and_its_thread_with_it() {
        let _serial = crate::jsonrpc::serially();
        let port = free_port();
        let mission = format!(r#"{{"host":"127.0.0.1","port":{port},"env":"mission"}}"#);

        let mut server = super::ensure_server(config(&mission)).expect("a free port binds");
        assert!(
            health_over_tcp(port)
                .expect("the mission bridge must serve")
                .contains("200 OK"),
            "a real connection was accepted during the mission — the condition \
             every crashing run shared"
        );

        let stopped = server.stop(super::EXPLICIT_STOP).expect("it was serving");
        assert_eq!(stopped.port, port);
        assert!(
            stopped.system_exited,
            "the actix System thread must actually leave, not merely stop listening"
        );
        assert!(
            health_over_tcp(port).is_err(),
            "the listener must be gone — without the stop this connect still succeeds"
        );
        assert!(
            server.stop(super::EXPLICIT_STOP).is_none(),
            "a stopped server has no handle left to stop — idempotent by type, \
             not by flag"
        );

        // The next mission's `require` → `jsonrpc.serve` binds a fresh one on the
        // freed port.
        let next = super::ensure_server(config(&mission)).expect("the port is free again");
        assert!(
            health_over_tcp(port)
                .expect("the next mission must be served too")
                .contains("200 OK"),
            "the fresh server serves on the same port"
        );
        drop(next);
    }

    /// **Card 18, iteration 3.** The guarantee the ownership refactor rests on:
    /// dropping the server — which in DCS is `__gc` inside `lua_close` for a
    /// mission that never fired its end event — stops the listener and takes the
    /// `System` thread with it, with nothing else asked of anyone.
    ///
    /// Mutation check for this path: neuter `Drop` (make it return before the
    /// `stop`) and this test fails on the refused-connect assertion, as does
    /// `teardown::tests::a_mission_state_is_released_before_it_dies_and_the_next_one_boots_over_it`.
    #[test]
    fn dropping_the_server_stops_it_even_though_nobody_asked() {
        let _serial = crate::jsonrpc::serially();
        let port = free_port();
        let server = super::ensure_server(config(&format!(
            r#"{{"host":"127.0.0.1","port":{port},"env":"mission"}}"#
        )))
        .expect("a free port binds");
        assert!(
            health_over_tcp(port)
                .expect("the mission bridge must serve")
                .contains("200 OK"),
            "connections are accepted while the owner holds it"
        );

        drop(server);

        assert!(
            health_over_tcp(port).is_err(),
            "the owner let go, so the listener is gone — no event, no teardown \
             call, just the value dying with its state"
        );
    }

    /// The split card 18 turns on: only the MISSION bridge's listener is stopped
    /// by an explicit teardown. The GUI state is created once at DCS start and
    /// lives until the process exits, and its server is the editor's only way in
    /// at the main menu — so a release evaluated against it must leave the
    /// listener up, decided on the server's own `env` identity rather than on
    /// trusting the caller.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_release_leaves_the_gui_bridges_server_alone() {
        let _serial = crate::jsonrpc::serially();
        let port = free_port();
        let mut server = super::ensure_server(config(&format!(
            r#"{{"host":"127.0.0.1","port":{port},"env":"gui"}}"#
        )))
        .expect("a free port binds");
        assert!(!server.serves_mission_state());

        let lua = Lua::new();
        let mut router = router(&lua);
        let released = crate::jsonrpc::teardown::release(&mut server, &mut router, "requested");
        assert_eq!(
            released.stopped_port, None,
            "the GUI bridge's listener is not the teardown's to stop"
        );
        assert!(
            health_over_tcp(port)
                .expect("the GUI bridge must still serve")
                .contains("dcs-studio-gui"),
            "the GUI bridge spans the process by design"
        );
    }

    /// The other half of card 20: making the bind outcome travel back from the
    /// server's own thread must not lose a real failure. A port somebody else
    /// holds has to reach Lua as an error the startup `pcall` can report — the
    /// bug being avoided is the mirror image of the one above, a bridge that
    /// reports success while nothing is listening.
    #[test]
    fn a_port_already_taken_is_reported_to_the_caller() {
        let _serial = crate::jsonrpc::serially();
        let squatter = std::net::TcpListener::bind("127.0.0.1:0").expect("squat");
        let port = squatter.local_addr().expect("addr").port();

        let Err(err) = JsonRpcServer::new(config(&format!(
            r#"{{"host":"127.0.0.1","port":{port},"env":"gui"}}"#
        ))) else {
            panic!("the port is taken, so there is nothing to serve on");
        };
        let err = err.to_string();
        assert!(
            err.contains("os error"),
            "the real cause reaches Lua: {err}"
        );
    }

    /// A queue with a 1 s request timeout and the pump-staleness refusal **off**,
    /// so a test can leave a request undrained for as long as it likes and still
    /// exercise the timeout path. The staleness behaviour has its own tests below,
    /// where the stamp is set deliberately rather than raced against the wall
    /// clock.
    fn app_data() -> Data<Mutex<AppData>> {
        Data::new(Mutex::new(AppData::with_stale_after(
            Duration::from_secs(1),
            ServiceInfo::new(Some("mission"), "127.0.0.1", 25570),
            None,
        )))
    }

    /// Backdate the pump stamp by `idle`, i.e. "nothing has drained this queue for
    /// `idle`" — the state a held breakpoint or a paused sim leaves the other
    /// bridge in, without waiting for real time to pass.
    fn pretend_idle_for(data: &Data<Mutex<AppData>>, idle: Duration) {
        let mut guard = lock_app_data(data);
        guard.last_drained = std::time::Instant::now()
            .checked_sub(idle)
            .expect("a monotonic clock that has not been running for `idle` yet");
    }

    fn request(
        id: Option<&str>,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> JsonRpcRequest {
        JsonRpcRequest {
            jsonrpc: JSON_RPC_VERSION.to_string(),
            method: method.to_string(),
            id: id.map(str::to_string),
            params,
        }
    }

    /// A router whose single method `echo` returns its params, plus `boom`
    /// which raises — the two shapes every handler outcome reduces to.
    fn router(lua: &Lua) -> JsonRpcRouter {
        let mut router = JsonRpcRouter::default();
        router.add_method(
            "echo".to_string(),
            lua.create_function(|_, v: mlua::Value| Ok(v))
                .expect("echo"),
            MethodMeta::default(),
        );
        router.add_method(
            "boom".to_string(),
            lua.load("return function() error('handler exploded') end")
                .eval()
                .expect("boom"),
            MethodMeta::default(),
        );
        router
    }

    /// The request timeout bounds how long an editor call can pin a queue slot.
    /// `0` is the documented escape hatch for interactive debugging, where a
    /// breakpoint legitimately holds a request for minutes; anything else would
    /// time the debugger out mid-session.
    #[test]
    fn a_zero_timeout_means_effectively_forever_and_an_absent_one_uses_the_default() {
        let base = r#"{"host":"127.0.0.1","port":0"#;
        assert_eq!(
            get_timeout_duration_from_config(&config(&format!("{base},\"timeout\":30}}"))),
            Duration::from_secs(30)
        );
        assert_eq!(
            get_timeout_duration_from_config(&config(&format!("{base}}}"))),
            DEFAULT_TIMEOUT
        );
        assert_eq!(
            get_timeout_duration_from_config(&config(&format!("{base},\"timeout\":0}}"))),
            Duration::from_secs(u64::MAX),
            "0 is the documented infinite timeout"
        );
    }

    /// The server config is a table the hook and the mission init write by
    /// hand, so it is the one place a typo reaches Rust. A value with no
    /// serializable form at all (a function — `timeout = os.clock` instead of
    /// `os.clock()` is the easy slip) and a well-formed table of the wrong
    /// types must both come back as Lua errors the startup pcall can report,
    /// never a panic and never a server quietly bound with defaults.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_config_that_is_not_plain_data_is_refused_with_the_cause() {
        use mlua::FromLua;

        let lua = Lua::new();
        let with_function: mlua::Value = lua
            .load(r#"return { host = "127.0.0.1", port = 25570, timeout = print }"#)
            .eval()
            .expect("eval config");
        let err = ServerConfig::from_lua(with_function, &lua)
            .expect_err("a function is not configuration");
        assert!(
            err.to_string().contains("function"),
            "the cause names what could not be read: {err}"
        );

        let wrong_types: mlua::Value = lua
            .load(r#"return { host = "127.0.0.1", port = "25570" }"#)
            .eval()
            .expect("eval config");
        let err = ServerConfig::from_lua(wrong_types, &lua).expect_err("a port is a number");
        assert!(
            err.to_string().contains("invalid type"),
            "the cause says what the value should have been: {err}"
        );

        // The shape the hook actually writes still reads.
        let good: mlua::Value = lua
            .load(r#"return { host = "127.0.0.1", port = 25569, timeout = 30, env = "gui" }"#)
            .eval()
            .expect("eval config");
        let config = ServerConfig::from_lua(good, &lua).expect("the hook's own config");
        assert_eq!(config.port, 25569);
        assert_eq!(config.env.as_deref(), Some("gui"));
    }

    /// `/health` and `rpc.discover` are how an agent probing 25569/25570 tells
    /// the two bridges apart, so the identity has to follow `env` — and default
    /// to the GUI bridge when a config omits it.
    #[test]
    fn the_service_identity_follows_the_environment_it_serves() {
        let mission = ServiceInfo::new(Some("mission"), "127.0.0.1", 25570);
        assert_eq!(mission.name, "dcs-studio-mission");
        assert_eq!(mission.env, "mission");
        assert_eq!(mission.port, 25570);

        let defaulted = ServiceInfo::default();
        assert_eq!(defaulted.name, "dcs-studio-gui");
        assert_eq!(defaulted.env, "gui");
        assert_eq!(defaulted.version, env!("CARGO_PKG_VERSION"));
    }

    /// A request gets a response channel; a notification (no id) does not, and
    /// still queues so its side effects run. Handing a notification a channel
    /// would leave the HTTP caller waiting for a reply that never comes.
    #[test]
    fn only_a_request_with_an_id_gets_a_response_channel() {
        let mut data = AppData::new(Duration::from_secs(1), ServiceInfo::default());

        assert!(push_rpc_request(&mut data, request(Some("1"), "echo", None)).is_some());
        assert!(push_rpc_request(&mut data, request(None, "echo", None)).is_none());
        assert_eq!(data.rpc_queue.len(), 2, "both are queued, in arrival order");
        assert_eq!(data.rpc_queue[0].request.id.as_deref(), Some("1"));
        assert!(data.rpc_queue[1].response_sender.is_none());
    }

    /// `rpc.discover` is answered by the server itself, ahead of the router, so
    /// every bridge and both transports get the `OpenRPC` document for free.
    /// As a notification it is a no-op — there is nowhere to send a document.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn rpc_discover_is_answered_by_the_server_ahead_of_the_router() {
        let lua = Lua::new();
        let router = router(&lua);
        let service = ServiceInfo::new(Some("mission"), "127.0.0.1", 25570);

        let response = process_request(
            &lua,
            &router,
            request(Some("d"), "rpc.discover", None),
            &service,
        )
        .expect("discover")
        .expect("a request gets a response");
        assert_eq!(response.id, "d");
        let result = response.result.expect("document");
        assert_eq!(result["info"]["title"], "dcs-studio-mission");
        // The method set is the router's, plus the synthetic rpc.discover entry
        // the builder adds — not a hard-coded list.
        let names: Vec<&str> = result["methods"]
            .as_array()
            .expect("methods")
            .iter()
            .filter_map(|m| m["name"].as_str())
            .collect();
        assert_eq!(names, vec!["boom", "echo", "rpc.discover"], "{names:?}");

        assert!(
            process_request(&lua, &router, request(None, "rpc.discover", None), &service)
                .expect("notification")
                .is_none()
        );
    }

    /// An unknown method is a JSON-RPC "method not found", carrying the name so
    /// the editor can say which call failed — and silence when it arrived as a
    /// notification, since there is no id to answer to.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn an_unknown_method_is_an_error_for_a_request_and_silence_for_a_notification() {
        let lua = Lua::new();
        let router = router(&lua);
        let service = ServiceInfo::default();

        let response = process_request(&lua, &router, request(Some("7"), "nope", None), &service)
            .expect("processed")
            .expect("a request gets a response");
        assert_eq!(response.id, "7");
        assert!(response.result.is_none());
        let error = response.error.expect("error");
        assert_eq!(error["code"], JSON_RPC_METHOD_NOT_FOUND);
        assert!(
            error["message"]
                .as_str()
                .is_some_and(|m| m.contains("nope")),
            "{error}"
        );

        assert!(
            process_request(&lua, &router, request(None, "nope", None), &service)
                .expect("processed")
                .is_none()
        );
    }

    /// A handler's result becomes the response; a raise becomes a JSON-RPC
    /// error with the Lua message but WITHOUT the stack traceback — the editor
    /// shows that string in a notification, and a traceback there is noise.
    /// A raising notification is still run, then dropped.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_handler_result_answers_and_a_raise_becomes_a_tracebackless_error() {
        let lua = Lua::new();
        let router = router(&lua);
        let service = ServiceInfo::default();

        let echoed = process_request(
            &lua,
            &router,
            request(Some("e"), "echo", Some(serde_json::json!({ "n": 3 }))),
            &service,
        )
        .expect("echo")
        .expect("response");
        assert_eq!(echoed.result.expect("result")["n"], 3);

        // No params at all is Lua nil, not an error.
        let bare = process_request(&lua, &router, request(Some("b"), "echo", None), &service)
            .expect("echo")
            .expect("response");
        assert!(bare.result.is_some());

        let failed = process_request(&lua, &router, request(Some("x"), "boom", None), &service)
            .expect("processed")
            .expect("response");
        let error = failed.error.expect("error");
        assert_eq!(error["code"], JSON_RPC_INTERNAL_ERROR);
        assert_eq!(error["message"], "LuaError");
        let data = error["data"].as_str().expect("cause");
        assert!(data.contains("handler exploded"), "{data}");
        assert!(!data.contains("stack traceback"), "{data}");

        assert!(
            process_request(&lua, &router, request(None, "boom", None), &service)
                .expect("processed")
                .is_none(),
            "a raising notification is run and then dropped"
        );
    }

    /// A result the serializer cannot represent becomes an error envelope
    /// carrying the real cause. The alternative — a response with neither
    /// result nor error — is one the editor cannot interpret at all, and a
    /// panic here would take the sim down.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn an_unserializable_result_becomes_an_error_envelope_with_the_cause() {
        let lua = Lua::new();
        let cyclic: mlua::Value = lua
            .load("local t = {}; t.self = t; return t")
            .eval()
            .expect("cycle");

        let response = response_for("c".to_string(), &cyclic);
        assert_eq!(response.id, "c");
        assert!(response.result.is_none(), "no half-built result");
        let error = response.error.expect("error");
        assert_eq!(error["message"], "result not serializable");
        assert!(
            error["data"]
                .as_str()
                .is_some_and(|d| d.contains("depth limit")),
            "{error}"
        );
    }

    /// A request's params cross into Lua as a fresh table, which is an
    /// allocation in a state DCS shares with the whole mission and can genuinely
    /// have exhausted. The drain must come back with an error for that one
    /// request — `respond` logs it and moves to the next — rather than panicking
    /// on the sim thread.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn params_that_cannot_be_allocated_fail_one_request_not_the_drain() {
        let lua = Lua::new();
        let router = router(&lua);
        let service = ServiceInfo::default();
        let params =
            serde_json::json!({ "a": [1, 2, 3], "b": "some text long enough to allocate" });

        let mut relaxed_enough_to_answer = false;
        for headroom in (0..64_000).step_by(8) {
            // Measure against a settled heap: the previous pass's garbage would
            // otherwise move where this one runs out.
            lua.gc_collect().expect("collect");
            let ceiling = lua.used_memory() + headroom;
            lua.set_memory_limit(ceiling)
                .expect("mlua owns this state's allocator");
            let outcome = process_request(
                &lua,
                &router,
                request(Some("p"), "echo", Some(params.clone())),
                &service,
            );
            lua.set_memory_limit(0).expect("lift the ceiling");
            match outcome {
                Ok(response) => {
                    assert_eq!(response.expect("a request is answered").id, "p");
                    relaxed_enough_to_answer = true;
                    break;
                }
                Err(e) => assert!(
                    e.to_string().contains("memory"),
                    "the request must fail on the squeeze, and say so: {e}"
                ),
            }
        }
        assert!(
            relaxed_enough_to_answer,
            "the squeeze never relaxed enough to answer — the test proves nothing"
        );
    }

    /// The `POST /rpc` transport's four answers, driven IN PROCESS — no socket,
    /// no worker thread, no sleep: a notification (202, accepted without
    /// waiting for a sim that has nothing to answer), a request the sim drains
    /// (200 with the body), a request nobody drains (500 on the server's own
    /// timeout), and one whose caller was dropped out of the queue by a mission
    /// reload (500 with the cause).
    ///
    /// The end-to-end forms of these live in `tests/jsonrpc_server.rs`. They
    /// are also the paths most exposed to a loaded CI runner, where a race the
    /// test cannot observe decides whether the timeout or the drop is what
    /// answers — so the contract is pinned here too, where nothing but the
    /// handler's own logic can decide it.
    #[actix_web::test]
    async fn the_post_transport_accepts_answers_and_fails_a_request_in_process() {
        use actix_web::{test, App};

        let data = app_data(); // a 1s request timeout
        let app =
            test::init_service(App::new().service(post_rpc).app_data(Data::clone(&data))).await;
        let post = |body: serde_json::Value| {
            test::TestRequest::post()
                .uri("/rpc")
                .set_json(body)
                .to_request()
        };

        // A notification is accepted at once: there is no id to answer to, and
        // making the caller wait a frame for nothing is the bug this prevents.
        let accepted = test::call_service(
            &app,
            post(serde_json::json!({ "jsonrpc": "2.0", "method": "bump" })),
        )
        .await;
        assert_eq!(accepted.status(), 202);
        {
            let mut queue = lock_app_data(&data);
            assert_eq!(queue.rpc_queue.len(), 1, "queued for its side effect");
            assert!(
                queue.rpc_queue[0].response_sender.is_none(),
                "and with nothing to answer to"
            );
            queue.rpc_queue.clear(); // the sim drained it; each phase starts empty
        }

        // A request the sim answers comes back as its serialized envelope. No
        // background task and no sleep: the handler enqueues SYNCHRONOUSLY
        // before its first await, so after one yield the request is in the
        // queue by construction — `join!` polls the handler first, and the
        // `expect` below is the invariant, not a hope.
        let sim = Data::clone(&data);
        let (answered, ()) = tokio::join!(
            test::call_service(
                &app,
                post(serde_json::json!({ "jsonrpc": "2.0", "id": "1", "method": "ping" })),
            ),
            async {
                actix_web::rt::task::yield_now().await;
                let queued = lock_app_data(&sim)
                    .rpc_queue
                    .pop_front()
                    .expect("the handler queues before it awaits");
                let sender = queued
                    .response_sender
                    .expect("a request carries its channel");
                let _ = sender.send(success_response(
                    queued.request.id.unwrap_or_default(),
                    serde_json::json!({ "pong": true }),
                ));
            }
        );
        assert_eq!(answered.status(), 200);
        let body = test::read_body(answered).await;
        let body = String::from_utf8_lossy(&body);
        assert!(body.contains(r#""id":"1""#), "{body}");
        assert!(body.contains(r#""pong":true"#), "{body}");

        // A request nobody drains fails on the server's own timeout rather than
        // pinning the connection: inside DCS the sim thread stops pumping for a
        // load screen, and an editor blocked forever looks like a hung IDE.
        let timed_out = test::call_service(
            &app,
            post(serde_json::json!({ "jsonrpc": "2.0", "id": "2", "method": "ping" })),
        )
        .await;
        assert_eq!(timed_out.status(), 500);
        let body = test::read_body(timed_out).await;
        assert!(
            String::from_utf8_lossy(&body).contains("Timed out"),
            "the caller is told why it was released"
        );

        // A caller dropped from the queue — what a mission reload does to
        // everything stranded in it — is released with the cause instead of
        // waiting out the timeout for an answer that can never come.
        //
        // The timed-out request above is still sitting in the queue (its caller
        // gave up, the entry did not), so clear it first: otherwise the reload
        // below would drop THAT one and this request would leave by the timeout
        // again, testing the previous case twice.
        lock_app_data(&data).rpc_queue.clear();
        let reload = Data::clone(&data);
        let (stranded, ()) = tokio::join!(
            test::call_service(
                &app,
                post(serde_json::json!({ "jsonrpc": "2.0", "id": "3", "method": "ping" })),
            ),
            async {
                actix_web::rt::task::yield_now().await;
                let queued = lock_app_data(&reload)
                    .rpc_queue
                    .pop_front()
                    .expect("the handler queues before it awaits");
                drop(queued); // the reload's swap-and-drop takes the channel with it
            }
        );
        assert_eq!(stranded.status(), 500);
        let body = test::read_body(stranded).await;
        let body = String::from_utf8_lossy(&body);
        assert!(
            !body.contains("Timed out"),
            "released by the drop, not by waiting out the timeout: {body}"
        );
    }

    /// **Card 17, the fix.** A request arriving while nothing is draining the
    /// queue is answered NOW, with the reason, instead of being parked for the
    /// server's whole deadline. Live, that deadline is 30 s and it was being
    /// burned by every GUI-bridge call for as long as a mission breakpoint was
    /// held — the transport perfectly healthy throughout, `/health` answering in
    /// 1-2 ms, and only the Lua-side drain stopped.
    ///
    /// Both transports, because the editor uses both: the status-bar poll is a
    /// `POST /rpc` and everything else rides the WebSocket.
    #[actix_web::test]
    async fn a_request_arriving_while_nothing_drains_the_queue_is_refused_at_once() {
        use actix_web::{test, App};

        let data = Data::new(Mutex::new(AppData::with_stale_after(
            // A 30 s deadline exactly as the hook configures, so the assertion
            // "this answered at all" is itself the proof it did not wait.
            Duration::from_secs(30),
            ServiceInfo::new(Some("gui"), "127.0.0.1", 25569),
            Some(Duration::from_secs(2)),
        )));
        let app =
            test::init_service(App::new().service(post_rpc).app_data(Data::clone(&data))).await;
        let post = || {
            test::TestRequest::post()
                .uri("/rpc")
                .set_json(serde_json::json!({ "jsonrpc": "2.0", "id": "1", "method": "eval" }))
                .to_request()
        };

        // Fresh pump: the request queues and waits, as it always did. Asserted
        // through the handler's own accept step rather than by calling the
        // service, because calling it would genuinely wait out the 30 s deadline
        // — which is precisely what the refusal below must not do.
        assert!(matches!(
            accept_request(&mut lock_app_data(&data), request(Some("q"), "eval", None)),
            Queued::Waiting(_)
        ));
        assert_eq!(lock_app_data(&data).rpc_queue.len(), 1);
        lock_app_data(&data).rpc_queue.clear();

        // The sim stops pumping — a held breakpoint in the mission state, or a
        // pause. Nothing else changes: the same listener, the same worker.
        pretend_idle_for(&data, Duration::from_secs(5));

        let refused = test::call_service(&app, post()).await;
        assert_eq!(refused.status(), 200, "a JSON-RPC error is still an answer");
        let body = test::read_body(refused).await;
        let answer: JsonRpcResponse = serde_json::from_slice(&body).expect("an envelope");
        assert_eq!(answer.id, "1");
        assert!(answer.result.is_none());
        let error = answer.error.expect("an error envelope");
        assert_eq!(error["code"], JSON_RPC_PUMP_STALLED);
        assert_eq!(error["message"], "sim not pumping");
        let detail = error["data"].as_str().expect("a cause");
        assert!(detail.contains("gui"), "names the bridge: {detail}");
        assert!(
            detail.contains("not been drained"),
            "names the observable fact rather than guessing the cause: {detail}"
        );
        assert!(
            detail.contains("listening"),
            "says the bridge is not broken, only unpumped: {detail}"
        );
        assert!(
            lock_app_data(&data).rpc_queue.is_empty(),
            "the refused request must NOT also be queued — a later drain \
             answering it would be a second reply to one call"
        );

        // The WS path refuses identically, and a notification is still queued: it
        // has no caller waiting and no deadline to burn, and its side effect must
        // still run on the frame the sim resumes.
        let (queued, _) =
            enqueue_text_frame(r#"{"jsonrpc":"2.0","id":"w","method":"eval"}"#, &data)
                .expect("a well-formed frame");
        let Queued::PumpStalled(response) = queued else {
            panic!("a stalled pump must refuse the frame, not queue it");
        };
        assert_eq!(response.id, "w");
        assert_eq!(
            response.error.expect("error")["code"],
            JSON_RPC_PUMP_STALLED
        );
        assert!(matches!(
            enqueue_text_frame(r#"{"jsonrpc":"2.0","method":"bump"}"#, &data),
            Some((Queued::Accepted, _))
        ));
        assert_eq!(lock_app_data(&data).rpc_queue.len(), 1, "the notification");

        // Nothing here is sticky: recovery is the stamp's job, and that a real
        // drain restores it is pinned by
        // `every_pump_stamps_the_liveness_clock_including_the_debuggers_drain` —
        // which needs a Lua state, and so cannot live in this test if this one is
        // to run on every platform.
    }

    /// The stamp itself: every pump goes through `drain_queue`, and since card
    /// 18's third iteration there is exactly one way to reach it — `process_rpc`
    /// on the server userdata the pumping state holds. The hook's
    /// `onSimulationFrame`, the mission state's model-time timer and BOTH bridges'
    /// `DBG.pump` all call that one method.
    ///
    /// That is what scopes the fix correctly for the debugger, and the reason no
    /// bridge needs exempting: while a debug session holds the sim thread, the
    /// engine pumps ITS bridge every 50 ms, so that bridge stays fresh and keeps
    /// answering `debug_state`/`debug_continue`. Only the bridge nobody is pumping
    /// — the GUI one, during a mission breakpoint — goes stale, which is exactly
    /// card 17's measured split.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn every_pump_stamps_the_liveness_clock_including_the_debuggers_drain() {
        let _serial = crate::jsonrpc::serially();
        let lua = Lua::new();
        let router = router(&lua);

        // A drain of an empty queue is still a pump that ran.
        let data = app_data();
        pretend_idle_for(&data, Duration::from_secs(5));
        assert!(lock_app_data(&data).pump_idle() >= Duration::from_secs(5));
        drain_queue(&lua, &data, &router);
        assert!(
            lock_app_data(&data).pump_idle() < Duration::from_secs(1),
            "the drain stamps the clock"
        );

        // A drain with something in the queue stamps it too — and stamps it AFTER
        // the handlers run, so a slow drain does not finish looking stale.
        pretend_idle_for(&data, Duration::from_secs(5));
        lock_app_data(&data).rpc_queue.push_back(AppRequest {
            request: request(None, "echo", None),
            response_sender: None,
        });
        drain_queue(&lua, &data, &router);
        assert!(lock_app_data(&data).pump_idle() < Duration::from_secs(1));

        // And the same through the userdata method every pump actually calls —
        // the one the debugger's pause loop drives while it holds the sim thread.
        let port = free_port();
        let server = JsonRpcServer::new(config(&format!(
            r#"{{"host":"127.0.0.1","port":{port},"env":"mission"}}"#
        )))
        .expect("bind");
        pretend_idle_for(&server.app_data, Duration::from_secs(5));
        assert!(
            lock_app_data(&server.app_data).pump_stall().is_some(),
            "the harness really did make it stale"
        );
        drain_queue(&lua, &server.app_data, &router);
        assert!(
            lock_app_data(&server.app_data).pump_stall().is_none(),
            "the debugger's own pump counts as the pump being alive, so a held \
             breakpoint must not make its bridge refuse debug_continue"
        );
        drop(server);
    }

    /// The threshold, and its escape hatch. Configurable because the two pumps
    /// have different natural cadences and a user with a pathological setup must
    /// be able to opt out; `0` means "never refuse", i.e. the pre-card-17
    /// behaviour of waiting out the request timeout.
    #[test]
    fn the_staleness_threshold_defaults_and_can_be_disabled() {
        let base = r#"{"host":"127.0.0.1","port":0"#;
        assert_eq!(
            get_pump_stale_after_from_config(&config(&format!("{base}}}"))),
            Some(PUMP_STALE_AFTER),
            "a config that says nothing gets the default"
        );
        assert_eq!(
            get_pump_stale_after_from_config(&config(&format!("{base},\"pump_stale_ms\":250}}"))),
            Some(Duration::from_millis(250))
        );
        assert_eq!(
            get_pump_stale_after_from_config(&config(&format!("{base},\"pump_stale_ms\":0}}"))),
            None,
            "0 disables the refusal"
        );

        // Disabled means a queue that has not been drained all session still
        // accepts requests, rather than refusing them.
        let data = app_data();
        pretend_idle_for(&data, Duration::from_mins(10));
        assert!(lock_app_data(&data).pump_stall().is_none());
        assert!(matches!(
            accept_request(&mut lock_app_data(&data), request(Some("1"), "echo", None)),
            Queued::Waiting(_)
        ));
    }

    /// `/health` is answered by the actix worker and needs nothing from Lua, which
    /// is why it stayed healthy in 1-2 ms throughout card 17's held breakpoint
    /// while `/rpc` could not be dispatched at all. So it has to carry the OTHER
    /// half — whether the pump is alive — or a client reading it concludes
    /// "listening" means "will be served", which is the inference card 04 / #32 is
    /// still built on.
    #[actix_web::test]
    async fn health_reports_pump_freshness_so_listening_is_not_read_as_alive() {
        use actix_web::{test, App};

        let data = Data::new(Mutex::new(AppData::with_stale_after(
            Duration::from_secs(30),
            ServiceInfo::new(Some("gui"), "127.0.0.1", 25569),
            Some(Duration::from_secs(2)),
        )));
        let app =
            test::init_service(App::new().service(get_health).app_data(Data::clone(&data))).await;
        let probe = || test::TestRequest::get().uri("/health").to_request();

        let fresh = test::call_service(&app, probe()).await;
        let body = test::read_body(fresh).await;
        let health: serde_json::Value = serde_json::from_slice(&body).expect("health json");
        assert_eq!(health["status"], "OK");
        assert_eq!(health["name"], "dcs-studio-gui");
        assert_eq!(health["pump_stalled"], false);
        assert!(
            health["pump_idle_ms"].as_u64().expect("idle ms") < 2_000,
            "{health}"
        );

        pretend_idle_for(&data, Duration::from_secs(5));
        let stalled = test::call_service(&app, probe()).await;
        let body = test::read_body(stalled).await;
        let health: serde_json::Value = serde_json::from_slice(&body).expect("health json");
        assert_eq!(
            health["status"], "OK",
            "the LISTENER is still fine — that is the whole point of the split"
        );
        assert_eq!(health["pump_stalled"], true);
        assert!(
            health["pump_idle_ms"].as_u64().expect("idle ms") >= 5_000,
            "{health}"
        );
    }

    /// An error envelope carries code, message and optional data, and omits
    /// `result` entirely — the wire shape the editor client parses.
    #[test]
    fn an_error_envelope_omits_result_and_keeps_its_optional_data() {
        let bare =
            error_response("1".to_string(), -32000, "nope".to_string(), None).expect("build error");
        assert_eq!(bare.jsonrpc, JSON_RPC_VERSION);
        assert!(bare.result.is_none());
        let error = bare.error.expect("error");
        assert_eq!(error["code"], -32000);
        assert!(error.get("data").is_none(), "absent data is omitted");

        let detailed = error_response(
            "2".to_string(),
            -32001,
            "nope".to_string(),
            Some(serde_json::json!("why")),
        )
        .expect("build error");
        assert_eq!(detailed.error.expect("error")["data"], "why");
    }

    /// A caller that gave up — an HTTP request that timed out and dropped its
    /// receiver — must not stop the drain: the sim thread is running this loop
    /// per frame, and one abandoned request cannot be allowed to strand the
    /// rest of the queue.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_caller_that_vanished_does_not_stop_the_drain() {
        let lua = Lua::new();
        let router = router(&lua);
        let service = ServiceInfo::default();

        // The ordinary case first: a caller still waiting gets its answer.
        let (sender, receiver) = tokio::sync::oneshot::channel::<JsonRpcResponse>();
        respond(
            &lua,
            &router,
            AppRequest {
                request: request(Some("here"), "echo", None),
                response_sender: Some(sender),
            },
            &service,
        );
        assert_eq!(
            receiver.blocking_recv().expect("answered").id,
            "here",
            "a waiting caller is answered on its own channel"
        );

        let (sender, receiver) = tokio::sync::oneshot::channel::<JsonRpcResponse>();
        drop(receiver);
        respond(
            &lua,
            &router,
            AppRequest {
                request: request(Some("gone"), "echo", None),
                response_sender: Some(sender),
            },
            &service,
        );

        // A request that carries an id but no channel at all (a queue entry
        // whose caller was swapped away) is processed and its answer dropped.
        respond(
            &lua,
            &router,
            AppRequest {
                request: request(Some("orphan"), "echo", None),
                response_sender: None,
            },
            &service,
        );

        // And a handler that raises is logged, not propagated.
        respond(
            &lua,
            &router,
            AppRequest {
                request: request(None, "boom", None),
                response_sender: None,
            },
            &service,
        );
    }

    /// A poisoned queue lock does not brick the bridge. A `Mutex` stays
    /// poisoned for the life of the process, so propagating it would leave
    /// every request failing and `/health` unanswerable for the rest of the
    /// DCS session — over data (a queue, a timeout, a service name) that cannot
    /// be left half-updated in a way that matters. The lock is recovered
    /// instead, exactly as `locks::with_lock` does for the debugger state.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn a_poisoned_queue_lock_is_recovered_rather_than_bricking_the_bridge() {
        let data = app_data();
        // Poison the mutex the way a real panic-under-lock would.
        let poisoner = Data::clone(&data);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.lock().expect("lock");
            panic!("poison the queue lock");
        })
        .join();
        assert!(data.lock().is_err(), "the mutex really is poisoned");

        // The WS read path still queues ...
        assert!(
            matches!(
                enqueue_text_frame(r#"{"jsonrpc":"2.0","id":"1","method":"echo"}"#, &data),
                Some((Queued::Waiting(_), _))
            ),
            "a poisoned lock must not cost the session its frames"
        );

        // ... and the sim's drain still answers it.
        let lua = Lua::new();
        drain_queue(&lua, &data, &router(&lua));
        assert!(
            lock_app_data(&data).rpc_queue.is_empty(),
            "the queue was drained through the recovered lock"
        );
    }

    /// One malformed frame must never kill the WebSocket session: the editor
    /// keeps the socket open for the whole debug run, and a dropped session
    /// mid-run loses every later step and inspect. A numeric id is the specific
    /// shape that used to do it — pelican's wire format makes ids strings.
    #[test]
    fn a_malformed_websocket_frame_is_skipped_not_fatal() {
        let data = app_data();

        assert!(enqueue_text_frame("not json at all", &data).is_none());
        assert!(
            enqueue_text_frame(r#"{"jsonrpc":"2.0","id":7,"method":"echo"}"#, &data).is_none(),
            "a numeric id fails serde and must be skipped, not propagated"
        );
        assert!(
            enqueue_text_frame(r#"{"jsonrpc":"2.0"}"#, &data).is_none(),
            "no method"
        );

        // A notification enqueues but yields no channel to await.
        assert!(matches!(
            enqueue_text_frame(r#"{"jsonrpc":"2.0","method":"echo"}"#, &data),
            Some((Queued::Accepted, _))
        ));
        // A well-formed request yields the channel and the configured timeout.
        let (queued, request_timeout) =
            enqueue_text_frame(r#"{"jsonrpc":"2.0","id":"1","method":"echo"}"#, &data)
                .expect("a request must queue");
        assert!(matches!(queued, Queued::Waiting(_)));
        assert_eq!(request_timeout, Duration::from_secs(1));

        let queued = data.lock().expect("lock").rpc_queue.len();
        assert_eq!(queued, 2, "only the two well-formed frames were queued");
    }

    /// **Card 18, iteration 3.** A request stranded in the queue when the owner
    /// lets go must be ANSWERED, not left to hang or to time out: the queue dies
    /// with the server, and the caller is told which of the two happened.
    ///
    /// This is the half that used to need a DLL-wide queue static and a separate
    /// sentinel userdata to reach. Now the queue belongs to the server, and the
    /// server belongs to the state, so `Drop` is the only place it has to happen.
    #[test]
    fn a_dropped_server_answers_the_callers_stranded_in_its_queue() {
        let _serial = crate::jsonrpc::serially();
        let port = free_port();
        let server = JsonRpcServer::new(config(&format!(
            r#"{{"host":"127.0.0.1","port":{port},"env":"mission"}}"#
        )))
        .expect("bind");
        let stranded = super::queue_against(&server, request(Some("stranded"), "echo", None))
            .expect("a request queues");

        drop(server);

        let answer = stranded
            .blocking_recv()
            .expect("the caller must be answered, not dropped");
        let error = answer.error.expect("an error envelope");
        assert_eq!(error["code"], super::JSON_RPC_BRIDGE_TORN_DOWN);
        assert_eq!(error["data"], crate::jsonrpc::teardown::STATE_GONE);
    }
}
