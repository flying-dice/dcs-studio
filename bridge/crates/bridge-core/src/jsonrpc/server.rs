use actix_web::dev::ServerHandle;
use actix_web::error::ErrorInternalServerError;
use actix_web::web::{Data, Json, Payload};
use actix_ws::{Message, Session};

use crate::jsonrpc::router::JsonRpcRouter;
use crate::jsonrpc::{
    JsonRpcError, JsonRpcRequest, JsonRpcResponse, JSON_RPC_INTERNAL_ERROR,
    JSON_RPC_METHOD_NOT_FOUND, JSON_RPC_VERSION,
};
use crate::lua_utils::serialize_lua_to_json;
use actix_web::{get, middleware, post, App, HttpRequest, HttpResponse, HttpServer};
use log::{debug, error, info, warn};
use mlua::prelude::{LuaError, LuaNil, LuaValue};
use mlua::{
    FromLua, IntoLuaMulti, Lua, LuaSerdeExt, MetaMethod, UserData, UserDataMethods, UserDataRef,
};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::error::Error;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tokio::runtime::Runtime;
use tokio::sync::oneshot;
use tokio::sync::oneshot::Receiver;
use tokio::task::spawn_local;
use tokio::time::timeout;

const DEFAULT_TIMEOUT: Duration = Duration::from_mins(5);

/// The running server's request queue, reachable DLL-wide so any code in this
/// DLL's Lua state can drain it — not just the holder of the `JsonRpcServer`
/// userdata. The debugger depends on this: while a chunk is paused at a
/// breakpoint the sim thread is blocked inside that state, the frame/timer
/// pump never fires, and the only code that can answer the editor's
/// resume/inspect requests is the pause loop itself, via
/// [`process_global_queue`]. Per DLL by construction — each cdylib compiles
/// its own copy of this static.
static GLOBAL_APP_DATA: Mutex<Option<Data<Mutex<AppData>>>> = Mutex::new(None);

/// The DLL-owned server slot behind [`ensure_server`] (`jsonrpc.serve`): the
/// mission DLL's `luaopen` re-runs on every mission load in a fresh Lua state,
/// but the DLL image (and this static) persists — the second load reuses the
/// running server instead of failing to re-bind the port.
static SERVER: Mutex<Option<JsonRpcServer>> = Mutex::new(None);

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

#[derive(Default)]
pub(crate) struct AppData {
    pub(crate) rpc_queue: VecDeque<AppRequest>,
    pub(crate) timeout: Duration,
    pub(crate) service: ServiceInfo,
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

#[derive(Serialize, Deserialize, Debug)]
struct Health {
    name: String,
    env: String,
    status: String,
    version: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub(crate) struct ServerConfig {
    host: String,
    port: u16,
    timeout: Option<u64>,
    /// The environment this bridge serves ("gui" / "mission") — names the
    /// service in `/health` and `rpc.discover`.
    env: Option<String>,
}

impl FromLua for ServerConfig {
    fn from_lua(value: LuaValue, lua: &Lua) -> mlua::Result<Self> {
        let value = lua.from_value(value)?;
        serde_json::from_value::<ServerConfig>(value).map_err(LuaError::external)
    }
}

pub(crate) struct JsonRpcServer {
    config: ServerConfig,
    handle: ServerHandle,
    app_data: Data<Mutex<AppData>>,
}

impl AppData {
    fn new(timeout: Duration, service: ServiceInfo) -> Self {
        AppData {
            rpc_queue: VecDeque::new(),
            timeout,
            service,
        }
    }
}

impl JsonRpcServer {
    fn new(config: ServerConfig) -> Result<Self, actix_web::Error> {
        let service = ServiceInfo::new(config.env.as_deref(), &config.host, config.port);
        let app_data = Data::new(Mutex::new(AppData::new(
            get_timeout_duration_from_config(&config),
            service,
        )));
        let app_data_2 = app_data.clone();

        let host = config.host.clone();
        let port = config.port;

        let server = HttpServer::new(move || {
            App::new()
                .wrap(middleware::Logger::default())
                .service(get_ws)
                .service(get_health)
                .service(post_rpc)
                .app_data(Data::clone(&app_data_2))
        })
        .workers(1)
        .bind((host, port))?
        .run();

        let handle = server.handle();

        thread::spawn(move || {
            info!("Starting server in new thread");
            actix_web::rt::System::new().block_on(async {
                info!("Server run finished: {:?}", server.await);
            });
        });

        // Publish the queue for process_global_queue (any-state drains). The
        // newest server wins; realistically there is exactly one per process.
        {
            let mut slot = GLOBAL_APP_DATA
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            *slot = Some(app_data.clone());
        }

        Ok(Self {
            config,
            handle,
            app_data,
        })
    }

    fn stop(&self, graceful: Option<bool>) {
        info!("Stopping server...");
        stop_on_thread(self.handle.clone(), graceful.unwrap_or(false));
        info!("Server fully stopped (blocking)");
    }
}

/// Start this DLL's server if none is running, else reuse the running one —
/// exposed to Lua as `jsonrpc.serve(config)`. The mission DLL calls this from
/// its embedded init on EVERY mission load: the first load binds the port and
/// parks the server in [`SERVER`] (alive for the process lifetime); later
/// loads reuse it and swap-drop any requests stranded in the queue between
/// missions — dropping their oneshot senders errors those callers out, so a
/// fresh mission never answers a stale request. Returns `true` when the
/// server was newly started.
pub(crate) fn ensure_server(config: ServerConfig) -> Result<bool, actix_web::Error> {
    let mut slot = SERVER
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(server) = slot.as_ref() {
        if server.config.port != config.port {
            warn!(
                "jsonrpc.serve: reusing the running server on port {} (requested {})",
                server.config.port, config.port
            );
        }
        let stale = std::mem::take(&mut lock_app_data(&server.app_data).rpc_queue);
        if !stale.is_empty() {
            info!(
                "jsonrpc.serve: dropped {} stale queued request(s)",
                stale.len()
            );
        }
        return Ok(false);
    }
    *slot = Some(JsonRpcServer::new(config)?);
    Ok(true)
}

/// Stop the server from a dedicated thread. `block_on` must never run on the
/// caller: stopping from inside a tokio runtime would panic, and the caller
/// here is the DCS Lua thread.
///
/// Infallible on purpose. The only ways this can go wrong are tokio refusing to
/// build a runtime and the stop thread panicking, neither of which a caller
/// could act on — and one of the callers is `Drop`, where a failure would have
/// to become a panic. A panic while unwinding aborts the process, and inside
/// DCS that takes the sim down. The outcome is logged instead.
fn stop_on_thread(handle: ServerHandle, graceful: bool) {
    let outcome = thread::spawn(move || {
        Runtime::new().map(|runtime| runtime.block_on(handle.stop(graceful)))
    })
    .join();
    info!("Server stop thread finished: {outcome:?}");
}

impl Drop for JsonRpcServer {
    fn drop(&mut self) {
        info!("Dropping server...");
        // Retire this server's queue from the global slot (unless a newer
        // server already replaced it) so process_global_queue can't drain a
        // dead server's queue.
        {
            let mut slot = GLOBAL_APP_DATA
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if slot
                .as_ref()
                .is_some_and(|d| std::ptr::eq(d.get_ref(), self.app_data.get_ref()))
            {
                *slot = None;
            }
        }
        // Best effort, and must never panic: a panic in Drop during unwinding
        // aborts the process — inside DCS that takes the sim down.
        stop_on_thread(self.handle.clone(), false);
        info!("Server fully dropped");
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

        methods.add_method(
            "stop",
            |_lua: &Lua, this: &JsonRpcServer, graceful: Option<bool>| {
                this.stop(graceful);
                Ok(())
            },
        );
    }
}

/// Swap the queue out under the lock, then run the Lua handlers unlocked: a
/// slow eval must not block the WS/HTTP tasks that are queueing new requests.
fn drain_queue(lua: &Lua, app_data: &Data<Mutex<AppData>>, router: &JsonRpcRouter) {
    let (queue, service) = {
        let mut data_guard = lock_app_data(app_data);
        (
            std::mem::take(&mut data_guard.rpc_queue),
            data_guard.service.clone(),
        )
    };

    for app_request in queue {
        respond(lua, router, app_request, &service);
    }
}

/// Drain the RUNNING server's queue through `router`, from whatever Lua state
/// the caller lives in. This is `process_rpc` minus the server handle: the
/// mission-state debugger pumps the editor's requests with its own router
/// while its pause (or its running chunk) holds the sim thread and the `GameGUI`
/// hook cannot run. Returns false when no server is up (nothing to drain).
pub(crate) fn process_global_queue(lua: &Lua, router: &JsonRpcRouter) -> bool {
    let app_data = {
        let slot = GLOBAL_APP_DATA
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        slot.clone()
    };
    let Some(app_data) = app_data else {
        return false;
    };
    drain_queue(lua, &app_data, router);
    true
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
    let (maybe_receiver, request_timeout) = {
        let mut data_guard = lock_app_data(&data);
        let maybe_receiver = push_rpc_request(&mut data_guard, request);
        (maybe_receiver, data_guard.timeout)
    };

    let Some(receiver) = maybe_receiver else {
        return Ok(HttpResponse::Accepted().body("OK"));
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
                    if let Some((receiver, request_timeout)) = enqueue_text_frame(&text, &data) {
                        let session = session.clone();
                        spawn_local(async move {
                            notify_session(session, receiver, request_timeout)
                                .await
                                .unwrap_or_else(|e| error!("{e}"));
                        });
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

/// Parse one WS text frame and enqueue it as a JSON-RPC request, returning the
/// response channel + timeout for a non-notification (the caller awaits it in a
/// detached task) or `None` for a notification / a malformed frame. The enqueue
/// is synchronous so frames keep their arrival order in the queue; only the
/// wait-and-reply is deferred. A malformed frame (bad JSON, numeric id, …) is
/// logged and skipped, never fatal: the session must survive one bad client
/// frame.
fn enqueue_text_frame(
    message: &str,
    data: &Data<Mutex<AppData>>,
) -> Option<(Receiver<JsonRpcResponse>, Duration)> {
    let Ok(request) = serde_json::from_str::<JsonRpcRequest>(message) else {
        error!("Failed to parse request, skipping frame: {message}");
        return None;
    };

    let mut data_guard = lock_app_data(data);
    let receiver = push_rpc_request(&mut data_guard, request)?;
    Some((receiver, data_guard.timeout))
}

#[get("/health")]
async fn get_health(data: Data<Mutex<AppData>>) -> Json<Health> {
    let service = lock_app_data(&data).service.clone();
    Json(Health {
        name: service.name,
        env: service.env,
        status: "OK".to_string(),
        version: service.version,
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // idiomatic in tests
mod tests {
    use super::{
        drain_queue, enqueue_text_frame, error_response, get_timeout_duration_from_config,
        lock_app_data, process_global_queue, process_request, push_rpc_request, respond,
        response_for, AppData, AppRequest, JsonRpcServer, ServerConfig, ServiceInfo,
        DEFAULT_TIMEOUT, JSON_RPC_INTERNAL_ERROR, JSON_RPC_METHOD_NOT_FOUND, JSON_RPC_VERSION,
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

    fn app_data() -> Data<Mutex<AppData>> {
        Data::new(Mutex::new(AppData::new(
            Duration::from_secs(1),
            ServiceInfo::new(Some("mission"), "127.0.0.1", 25570),
        )))
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
            enqueue_text_frame(r#"{"jsonrpc":"2.0","id":"1","method":"echo"}"#, &data).is_some(),
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
        assert!(enqueue_text_frame(r#"{"jsonrpc":"2.0","method":"echo"}"#, &data).is_none());
        // A well-formed request yields the channel and the configured timeout.
        let (_receiver, request_timeout) =
            enqueue_text_frame(r#"{"jsonrpc":"2.0","id":"1","method":"echo"}"#, &data)
                .expect("a request must queue");
        assert_eq!(request_timeout, Duration::from_secs(1));

        let queued = data.lock().expect("lock").rpc_queue.len();
        assert_eq!(queued, 2, "only the two well-formed frames were queued");
    }

    /// The debugger's pause loop calls this every iteration, from whatever
    /// state it is stuck in, and it must answer honestly at every point in a
    /// server's life: nothing to drain before one is bound, the running one
    /// while it is up, and nothing again once it has been dropped. Draining a
    /// dead server's queue would hand the editor responses from the mission
    /// that just ended.
    ///
    /// This is the only test in the lib binary that binds a port, so the
    /// "before" and "after" assertions about the DLL-wide slot hold.
    #[test]
    #[cfg_attr(windows, ignore = "needs DCS's lua.dll on the runtime path")]
    fn the_global_drain_follows_the_running_server_in_and_out_of_existence() {
        let lua = Lua::new();
        let router = router(&lua);
        assert!(
            !process_global_queue(&lua, &router),
            "no server bound yet, so there is nothing to serve"
        );

        let port = {
            let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("probe");
            probe.local_addr().expect("addr").port()
        };
        let server = JsonRpcServer::new(config(&format!(
            r#"{{"host":"127.0.0.1","port":{port},"env":"mission"}}"#
        )))
        .expect("bind");
        assert!(
            process_global_queue(&lua, &router),
            "the running server's queue is reachable from any state"
        );

        drop(server);
        assert!(
            !process_global_queue(&lua, &router),
            "a dropped server retires its queue rather than leaving it drainable"
        );
    }
}
