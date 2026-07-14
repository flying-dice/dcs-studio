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
use mlua::Error::RuntimeError;
use mlua::{
    FromLua, IntoLuaMulti, Lua, LuaSerdeExt, MetaMethod, UserData, UserDataMethods, UserDataRef,
};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
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
                match server.await {
                    Ok(()) => info!("Server stopped!"),
                    Err(e) => error!("Error running server: {e:?}"),
                }
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

    fn stop(&self, graceful: Option<bool>) -> Result<(), tokio::io::Error> {
        info!("Stopping server...");

        let graceful = graceful.unwrap_or(false);

        stop_on_thread(self.handle.clone(), graceful)?;
        info!("Server fully stopped (blocking)");

        Ok(())
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
        let stale = {
            let mut data = server
                .app_data
                .lock()
                .map_err(|e| ErrorInternalServerError(format!("data lock: {e}")))?;
            std::mem::take(&mut data.rpc_queue)
        };
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
fn stop_on_thread(handle: ServerHandle, graceful: bool) -> Result<(), tokio::io::Error> {
    thread::spawn(move || -> Result<(), tokio::io::Error> {
        Runtime::new()?.block_on(async move {
            handle.stop(graceful).await;
        });
        Ok(())
    })
    .join()
    .map_err(|_| tokio::io::Error::other("server stop thread panicked"))?
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
        match stop_on_thread(self.handle.clone(), false) {
            Ok(()) => info!("Server fully dropped"),
            Err(e) => error!("Failed to stop server on drop: {e}"),
        }
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
                drain_queue(lua, &this.app_data, &router)?;
                true.into_lua_multi(lua)
            },
        );

        methods.add_method(
            "stop",
            |_lua: &Lua, this: &JsonRpcServer, graceful: Option<bool>| {
                this.stop(graceful).map_err(LuaError::external)?;
                Ok(())
            },
        );
    }
}

/// Swap the queue out under the lock, then run the Lua handlers unlocked: a
/// slow eval must not block the WS/HTTP tasks that are queueing new requests.
fn drain_queue(
    lua: &Lua,
    app_data: &Data<Mutex<AppData>>,
    router: &JsonRpcRouter,
) -> Result<(), LuaError> {
    let (queue, service) = {
        let mut data_guard = app_data.lock().map_err(|e| {
            error!("Error acquiring data lock: {e:?}");
            RuntimeError(format!("Error acquiring data lock: {e:?}"))
        })?;
        (
            std::mem::take(&mut data_guard.rpc_queue),
            data_guard.service.clone(),
        )
    };

    for app_request in queue {
        respond(lua, router, app_request, &service);
    }

    Ok(())
}

/// Drain the RUNNING server's queue through `router`, from whatever Lua state
/// the caller lives in. This is `process_rpc` minus the server handle: the
/// mission-state debugger pumps the editor's requests with its own router
/// while its pause (or its running chunk) holds the sim thread and the `GameGUI`
/// hook cannot run. Returns false when no server is up (nothing to drain).
pub(crate) fn process_global_queue(lua: &Lua, router: &JsonRpcRouter) -> Result<bool, LuaError> {
    let app_data = {
        let slot = GLOBAL_APP_DATA
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        slot.clone()
    };
    let Some(app_data) = app_data else {
        return Ok(false);
    };
    drain_queue(lua, &app_data, router)?;
    Ok(true)
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
        let mut data_guard = data
            .lock()
            .map_err(|e| ErrorInternalServerError(format!("Failed to acquire data lock: {e}")))?;
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
                    if session.pong(&bytes).await.is_err() {
                        error!("Failed to send pong");
                    }
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

    let Ok(mut data_guard) = data.lock() else {
        error!("Failed to acquire data lock, skipping frame");
        return None;
    };
    let receiver = push_rpc_request(&mut data_guard, request)?;
    Some((receiver, data_guard.timeout))
}

#[get("/health")]
async fn get_health(data: Data<Mutex<AppData>>) -> Result<Json<Health>, actix_web::Error> {
    let service = {
        let data_guard = data
            .lock()
            .map_err(|e| ErrorInternalServerError(format!("Failed to acquire data lock: {e}")))?;
        data_guard.service.clone()
    };

    Ok(Json(Health {
        name: service.name,
        env: service.env,
        status: "OK".to_string(),
        version: service.version,
    }))
}

/// Process one queued request and push its response (if any) back over the
/// requester's channel. Failures are logged — one bad request must not stop
/// the drain.
fn respond(lua: &Lua, router: &JsonRpcRouter, app_request: AppRequest, service: &ServiceInfo) {
    match process_request(lua, router, app_request.request, service) {
        Ok(Some(response)) => {
            info!("Sending response: {response:?}");
            match app_request.response_sender {
                Some(sender) => {
                    if sender.send(response).is_err() {
                        error!("Failed to send response");
                    }
                }
                None => info!("Processed notification: {response:?}"),
            }
        }
        Ok(None) => info!("Processed notification"),
        Err(e) => error!("Failed to process request: {e:?}"),
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

/// Build the success envelope for a handler's `result`. A result the serializer
/// can't represent — a cyclic table past the depth cap, a function, … — becomes
/// a JSON-RPC error carrying the real cause, not a resultless response the
/// editor can't interpret, and never a panic that would take the sim down.
fn ok_response(id: String, result: &LuaValue) -> JsonRpcResponse {
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
        Ok(result) => Ok(Some(ok_response(id, &result))),
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

async fn notify_session(
    mut session: Session,
    receiver: Receiver<JsonRpcResponse>,
    timeout_duration: Duration,
) -> Result<(), String> {
    let response = timeout(timeout_duration, receiver)
        .await
        .map_err(|e| format!("ERR: TIMEOUT: {e:?}"))?
        .map_err(|e| format!("ERR: FAILED RES: {e:?}"))?;

    let response_body =
        serde_json::to_string(&response).map_err(|e| format!("ERR: RESP SERDE FAILED: {e:?}"))?;

    session
        .text(response_body)
        .await
        .map_err(|e| format!("ERR: RESP SERDE FAILED: {e:?}"))?;

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
