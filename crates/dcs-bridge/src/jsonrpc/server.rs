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
use std::ops::Deref;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tokio::runtime::Runtime;
use tokio::sync::oneshot;
use tokio::sync::oneshot::Receiver;
use tokio::task::spawn_local;
use tokio::time::timeout;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(300); // 5 minutes

pub struct AppRequest {
    pub request: JsonRpcRequest,
    pub response_sender: Option<oneshot::Sender<JsonRpcResponse>>,
}

#[derive(Default)]
pub struct AppData {
    pub rpc_queue: VecDeque<AppRequest>,
    pub timeout: Duration,
}

#[derive(Serialize, Deserialize, Debug)]
struct Health {
    name: String,
    status: String,
    version: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct ServerConfig {
    host: String,
    port: u16,
    timeout: Option<u64>,
}

impl FromLua for ServerConfig {
    fn from_lua(value: LuaValue, lua: &Lua) -> mlua::Result<Self> {
        let value = lua.from_value(value)?;
        serde_json::from_value::<ServerConfig>(value).map_err(LuaError::external)
    }
}

pub struct JsonRpcServer {
    config: ServerConfig,
    handle: ServerHandle,
    app_data: Data<Mutex<AppData>>,
}

impl AppData {
    fn new(timeout: Duration) -> Self {
        AppData {
            rpc_queue: VecDeque::new(),
            timeout,
        }
    }
}

impl JsonRpcServer {
    fn new(config: ServerConfig) -> Result<Self, actix_web::Error> {
        let app_data = Data::new(Mutex::new(AppData::new(get_timeout_duration_from_config(
            &config,
        ))));
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
                    Ok(_) => info!("Server stopped!"),
                    Err(e) => error!("Error running server: {:?}", e),
                }
            });
        });

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
        // Best effort, and must never panic: a panic in Drop during unwinding
        // aborts the process — inside DCS that takes the sim down.
        match stop_on_thread(self.handle.clone(), false) {
            Ok(()) => info!("Server fully dropped"),
            Err(e) => error!("Failed to stop server on drop: {}", e),
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
                // Swap the queue out under the lock, then run the Lua handlers
                // unlocked: a slow eval must not block the WS/HTTP tasks that
                // are queueing new requests.
                let queue = {
                    let mut data_guard = this.app_data.lock().map_err(|e| {
                        error!("Error acquiring data lock: {:?}", e);
                        RuntimeError(format!("Error acquiring data lock: {:?}", e))
                    })?;
                    std::mem::take(&mut data_guard.rpc_queue)
                };

                for app_request in queue {
                    respond(lua, router.deref(), app_request);
                }

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
            .map_err(|e| ErrorInternalServerError(format!("Failed to acquire data lock: {}", e)))?;
        let maybe_receiver = push_rpc_request(&mut data_guard, request);
        (maybe_receiver, data_guard.timeout)
    };

    let Some(receiver) = maybe_receiver else {
        return Ok(HttpResponse::Accepted().body("OK"));
    };

    let result = timeout(request_timeout, receiver).await.map_err(|_| {
        ErrorInternalServerError(format!("Timed out max: {:?} seconds", request_timeout))
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
                    handle_text_frame(text.to_string(), &session, &data).await;
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

/// Queue one WS text frame as a JSON-RPC request and, for a non-notification,
/// relay its response back over the session. A malformed frame (bad JSON,
/// numeric id, …) is logged and skipped, never fatal: the session must survive
/// one bad client frame.
async fn handle_text_frame(message: String, session: &Session, data: &Data<Mutex<AppData>>) {
    let Ok(request) = serde_json::from_str::<JsonRpcRequest>(&message) else {
        error!("Failed to parse request, skipping frame: {}", message);
        return;
    };

    // Enqueue under the std Mutex in a block that ends before the `.await`
    // below — a guard must never span an await point inside the sim.
    let (maybe_receiver, request_timeout) = {
        let Ok(mut data_guard) = data.lock() else {
            error!("Failed to acquire data lock, skipping frame");
            return;
        };
        let maybe_receiver = push_rpc_request(&mut data_guard, request);
        (maybe_receiver, data_guard.timeout)
    };

    if let Some(receiver) = maybe_receiver {
        notify_session(session.clone(), receiver, request_timeout)
            .await
            .unwrap_or_else(|e| error!("{}", e))
    }
}

#[get("/health")]
async fn get_health() -> Json<Health> {
    let health = Health {
        name: "dcs-bridge".to_string(),
        status: "OK".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    };

    Json(health)
}

/// Process one queued request and push its response (if any) back over the
/// requester's channel. Failures are logged — one bad request must not stop
/// the drain.
fn respond(lua: &Lua, router: &JsonRpcRouter, app_request: AppRequest) {
    match process_request(lua, router, app_request.request) {
        Ok(Some(response)) => {
            info!("Sending response: {:?}", response);
            match app_request.response_sender {
                Some(sender) => {
                    if sender.send(response).is_err() {
                        error!("Failed to send response");
                    }
                }
                None => info!("Processed notification: {:?}", response),
            }
        }
        Ok(None) => info!("Processed notification"),
        Err(e) => error!("Failed to process request: {:?}", e),
    }
}

fn ok_response(id: String, result: &LuaValue) -> JsonRpcResponse {
    JsonRpcResponse {
        jsonrpc: JSON_RPC_VERSION.to_string(),
        id,
        result: serialize_lua_to_json(result),
        error: None,
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
) -> Result<Option<JsonRpcResponse>, LuaError> {
    debug!("Processing RPC request: {:?}", request);

    let method_name = request.method.clone();

    debug!("Getting method: {:?}", method_name);
    let Some(method) = router.get_method(request.method) else {
        warn!("Method not found!");
        let Some(id) = request.id else { return Ok(None) };
        let message = format!("Method not found: {}", method_name);
        return error_response(id, JSON_RPC_METHOD_NOT_FOUND, message, None).map(Some);
    };

    debug!("Method found, mapping parameters: {:?}", request.params);
    let params: LuaValue = match request.params {
        Some(params) => lua.to_value(&params).map_err(LuaError::external)?,
        None => LuaNil,
    };

    debug!("Calling Lua method with params: {:?}, {:?}", method, params);

    match method.call::<LuaValue>(params) {
        Ok(result) => {
            debug!("Method call successful, result: {:?}", result);
            let Some(id) = request.id else { return Ok(None) };
            Ok(Some(ok_response(id, &result)))
        }
        Err(e) => {
            error!("Method call failed: {}", e);
            let Some(id) = request.id else { return Ok(None) };

            // Strip the Lua stack traceback: the editor only needs the message.
            let msg = e.to_string();
            let msg = msg.split("\nstack traceback:").next().unwrap_or(&msg);
            let data = serde_json::to_value(msg).map_err(LuaError::external)?;

            error_response(id, JSON_RPC_INTERNAL_ERROR, "LuaError".to_string(), Some(data))
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
        request_id.clone().unwrap_or("notification".to_string()),
        request
    );

    match request_id {
        Some(id) => {
            debug!("Adding request to queue with id: {}", id);
            let (sender, receiver) = oneshot::channel::<JsonRpcResponse>();
            data.rpc_queue.push_back(AppRequest {
                request,
                response_sender: Some(sender),
            });
            Some(receiver)
        }
        None => {
            debug!("Adding notification to queue");
            data.rpc_queue.push_back(AppRequest {
                request,
                response_sender: None,
            });
            None
        }
    }
}

async fn notify_session(
    mut session: Session,
    receiver: Receiver<JsonRpcResponse>,
    timeout_duration: Duration,
) -> Result<(), String> {
    let response = timeout(timeout_duration, receiver)
        .await
        .map_err(|e| format!("ERR: TIMEOUT: {:?}", e))?
        .map_err(|e| format!("ERR: FAILED RES: {:?}", e))?;

    let response_body =
        serde_json::to_string(&response).map_err(|e| format!("ERR: RESP SERDE FAILED: {:?}", e))?;

    session
        .text(response_body)
        .await
        .map_err(|e| format!("ERR: RESP SERDE FAILED: {:?}", e))?;

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
