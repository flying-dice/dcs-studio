//! App-hosted MCP server (issues #33, #39): the IDE exposes its tool surface to
//! local agents over **standard MCP Streamable HTTP**, served by the official
//! `rmcp` SDK — no hand-rolled wire. Tools dispatch through `studio_mcp` with
//! the app's LIVE DCS link, so an agent and the IDE share the one open
//! connection to the sim instead of a sidecar dialing a second (which would
//! collide on the bridge).
//!
//! One IDE per machine, so the server binds a FIXED loopback port ([`MCP_PORT`])
//! and **fails closed** if it is taken — never a random fallback that no editor
//! could have been configured for. The surface is **unauthenticated**: it
//! trusts the loopback-only bind to keep it reachable from this machine alone,
//! so any editor's config is just a URL. (Note: the surface includes `dcs_eval`,
//! so any local process can run Lua in the sim — that is the accepted trade for
//! a config with no secret to manage.)
//!
//! The blocking tool dispatch runs on a dedicated OS thread (not a tokio worker)
//! so the per-session `studio_mcp::Session` can drive its own runtime exactly as
//! the stdio host does — see [`DcsStudioServer::call_tool`].

use std::path::Path;
use std::sync::{Arc, Mutex};

use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CallToolRequestParam, CallToolResult, Content, ErrorCode, ErrorData, Implementation,
    ListToolsResult, PaginatedRequestParam, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use serde_json::Value;
use studio_mcp::Session;
use tauri::{AppHandle, Manager};

// The fixed loopback port and endpoint path are owned by the shared project kit
// (`dcs_studio_project::mcp`) — the one source the scaffolded `.mcp.json` and
// this server both read, so they can never drift. Re-exported so existing
// references to `crate::mcp::MCP_PORT` keep resolving.
pub use dcs_studio_project::mcp::MCP_PORT;
use dcs_studio_project::mcp::MCP_PATH;

/// Where `{ port, url }` is persisted for discovery — beside the app's other
/// config, in the per-user config dir. `pub(crate)` so the terminal's harness
/// profiles can point the same file at their child's environment (`term.rs`).
pub(crate) const SESSION_FILE: &str = "mcp.json";

/// The MCP server's runtime status, surfaced to the status-bar indicator and
/// the setup-help modal (`mcp_status` command).
#[derive(Clone, serde::Serialize)]
pub struct McpStatus {
    /// Whether the server bound the fixed port and is serving.
    pub running: bool,
    /// The fixed port ([`MCP_PORT`]) — reported even on failure so the modal can
    /// still show the intended endpoint.
    pub port: u16,
    /// The full Streamable HTTP endpoint, e.g. `http://127.0.0.1:25570/mcp`.
    pub url: String,
    /// Why the server is not running (a port clash, …); `None` when it is
    /// serving.
    pub error: Option<String>,
}

impl McpStatus {
    fn url_for(port: u16) -> String {
        dcs_studio_project::mcp::url_for(port)
    }

    fn running(port: u16) -> Self {
        McpStatus {
            running: true,
            port,
            url: Self::url_for(port),
            error: None,
        }
    }

    fn failed(message: String) -> Self {
        McpStatus {
            running: false,
            port: MCP_PORT,
            url: Self::url_for(MCP_PORT),
            error: Some(message),
        }
    }
}

impl Default for McpStatus {
    /// Before `start` runs: not serving, no error yet.
    fn default() -> Self {
        McpStatus {
            running: false,
            port: MCP_PORT,
            url: Self::url_for(MCP_PORT),
            error: None,
        }
    }
}

/// Managed Tauri state holding the live MCP status (read by `mcp_status`).
#[derive(Default)]
pub struct McpServerState(Mutex<McpStatus>);

impl McpServerState {
    fn set(&self, status: McpStatus) {
        if let Ok(mut guard) = self.0.lock() {
            *guard = status;
        }
    }

    fn snapshot(&self) -> McpStatus {
        self.0
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_else(|_| McpStatus::failed("status lock poisoned".to_string()))
    }
}

/// The current MCP status — the status-bar indicator and setup-help modal read
/// this once on mount (the server starts at app boot, so it is settled by then).
#[tauri::command]
pub fn mcp_status(state: tauri::State<'_, McpServerState>) -> McpStatus {
    state.snapshot()
}

/// Start the MCP server. The fixed port is bound synchronously so a clash fails
/// closed here — visible in the status bar — rather than falling back to a port
/// nothing could discover. The IDE itself runs on regardless.
pub fn start(app: &AppHandle) {
    app.manage(McpServerState::default());
    let state = app.state::<McpServerState>();

    let link = app.state::<crate::dcs::DcsState>().link();

    // Fixed port or fail closed: one IDE per machine, so a clash is an error, not
    // a cue to pick another port (issue #39).
    let listener = match bind_loopback(MCP_PORT) {
        Ok(listener) => listener,
        Err(message) => {
            tracing::error!(port = MCP_PORT, %message, "mcp: fixed port unavailable — server not started");
            state.set(McpStatus::failed(message));
            return;
        }
    };

    // Best-effort discovery file for the harness env (`term.rs`); the surface is
    // reachable without it (fixed port, no token), so a write failure is fine.
    if let Err(error) = write_discovery_file(app) {
        tracing::warn!(%error, "mcp: could not write the discovery file");
    }

    state.set(McpStatus::running(MCP_PORT));
    tracing::info!(port = MCP_PORT, "mcp: Streamable HTTP server listening");

    let session = Arc::new(Session::with_link(link));
    std::thread::spawn(move || serve(listener, session));
}

/// Bind the loopback MCP listener (non-blocking), returning the failure message
/// on a clash so `start` can fail closed — never a random fallback (issue #39,
/// model `FailsClosedOnPortClash`). Parameterised by port purely so the
/// fail-closed path is testable without contending for the fixed port.
fn bind_loopback(port: u16) -> Result<std::net::TcpListener, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", port))
        .map_err(|error| format!("port {port} unavailable: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("listener setup: {error}"))?;
    Ok(listener)
}

/// Run the axum/`rmcp` server on its own tokio runtime (this thread is not a
/// tokio worker, so the per-session `Session` can still drive its own runtime in
/// the blocking dispatch). Returns only when the server stops.
fn serve(listener: std::net::TcpListener, session: Arc<Session>) {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            tracing::error!(%error, "mcp: could not build the server runtime");
            return;
        }
    };
    runtime.block_on(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                tracing::error!(%error, "mcp: could not adopt the listener");
                return;
            }
        };
        let http = StreamableHttpService::new(
            move || Ok(DcsStudioServer::new(session.clone())),
            Arc::new(LocalSessionManager::default()),
            StreamableHttpServerConfig::default(),
        );
        let router = axum::Router::new()
            .nest_service(MCP_PATH, http)
            // Block the DNS-rebinding vector: the surface is unauthenticated and
            // trusts only local tools, so reject anything that isn't.
            .layer(axum::middleware::from_fn(guard_loopback));
        if let Err(error) = axum::serve(listener, router).await {
            tracing::error!(%error, "mcp: server exited");
        }
    });
}

/// Reject any request that is not from a local tool, closing the DNS-rebinding
/// hole: the surface is unauthenticated (it trusts the loopback bind), so a
/// website that rebinds its hostname to `127.0.0.1` must not be able to reach it
/// and drive `dcs_eval`. A browser always sends an `Origin`; a rebound request
/// carries the attacker's host in `Origin`/`Host`. Local CLIs/editors send no
/// `Origin` and a loopback `Host`. So: any `Origin` present must be loopback,
/// and the `Host` must be loopback. (The MCP spec requires this for local
/// Streamable HTTP servers; `rmcp` does not enforce it.)
async fn guard_loopback(request: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    use axum::http::{header, StatusCode};
    use axum::response::IntoResponse;

    let headers = request.headers();
    let origin_ok = headers
        .get(header::ORIGIN)
        .is_none_or(|value| value.to_str().is_ok_and(is_loopback_origin));
    let host_ok = headers
        .get(header::HOST)
        .is_some_and(|value| value.to_str().is_ok_and(is_loopback_host));
    if origin_ok && host_ok {
        next.run(request).await
    } else {
        StatusCode::FORBIDDEN.into_response()
    }
}

/// The host portion of an authority (`host`, `host:port`, or a bracketed IPv6
/// `[::1]` / `[::1]:port`), with any port stripped.
fn host_only(authority: &str) -> &str {
    if let Some(rest) = authority.strip_prefix('[') {
        rest.split(']').next().unwrap_or(rest)
    } else {
        authority.split(':').next().unwrap_or(authority)
    }
}

/// Whether an authority names the loopback interface.
fn is_loopback_host(authority: &str) -> bool {
    matches!(host_only(authority), "127.0.0.1" | "localhost" | "::1")
}

/// Whether an `Origin` (`scheme://authority`) is loopback. A non-URL origin
/// (e.g. `null` from a sandboxed page) is not.
fn is_loopback_origin(origin: &str) -> bool {
    origin
        .split_once("://")
        .is_some_and(|(_, authority)| is_loopback_host(authority))
}

/// The `rmcp` server handler: a thin `ServerHandler` whose tool methods delegate
/// to the shared `studio_mcp` dispatch over the app's live DCS link. One per HTTP
/// session, all sharing the one `Session` (and thus the one link).
#[derive(Clone)]
struct DcsStudioServer {
    session: Arc<Session>,
}

impl DcsStudioServer {
    fn new(session: Arc<Session>) -> Self {
        DcsStudioServer { session }
    }
}

impl ServerHandler for DcsStudioServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            server_info: Implementation::from_build_env(),
            instructions: Some(
                "DCS Studio IDE tool surface: project, workspace fs, the live DCS link, \
                 injection, mission scripting, and the dcs-lua engine."
                    .to_string(),
            ),
            ..ServerInfo::default()
        }
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParam>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let specs = studio_mcp::tools_list();
        let tools: Vec<Tool> = serde_json::from_value(
            specs.get("tools").cloned().unwrap_or(Value::Null),
        )
        .map_err(|error| {
            ErrorData::new(
                ErrorCode::INTERNAL_ERROR,
                format!("tool specs: {error}"),
                None,
            )
        })?;
        Ok(ListToolsResult {
            tools,
            next_cursor: None,
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParam,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let session = self.session.clone();
        let name = request.name.to_string();
        let arguments = Value::Object(request.arguments.unwrap_or_default());

        // The dispatch is synchronous and drives the `Session`'s own runtime; run
        // it on a fresh OS thread (no ambient tokio runtime) so that inner
        // `block_on` cannot panic, exactly as the stdio host runs it.
        let (tx, rx) = tokio::sync::oneshot::channel();
        std::thread::spawn(move || {
            let _ = tx.send(studio_mcp::call_tool(&session, &name, &arguments));
        });

        match rx.await {
            Ok(Ok(value)) => Ok(tool_result(&value)),
            Ok(Err(error)) => Err(ErrorData::new(
                ErrorCode(error.code as i32),
                error.message,
                None,
            )),
            Err(_) => Err(ErrorData::new(
                ErrorCode::INTERNAL_ERROR,
                "mcp dispatch thread vanished".to_string(),
                None,
            )),
        }
    }
}

/// Map `studio_mcp`'s tool result JSON (`{ content: [{ type: "text", text }], isError }`)
/// onto an `rmcp` `CallToolResult`. The dispatch always emits text content.
fn tool_result(value: &Value) -> CallToolResult {
    let is_error = value
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let text = value
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    let content = vec![Content::text(text)];
    if is_error {
        CallToolResult::error(content)
    } else {
        CallToolResult::success(content)
    }
}

/// Write `<app-config>/mcp.json` = `{ port, url }` for the harness env discovery
/// path (`term.rs`). No secret — the surface is unauthenticated.
fn write_discovery_file(app: &AppHandle) -> std::io::Result<()> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    write_discovery_file_at(&dir)
}

/// The body of [`write_discovery_file`], over an explicit config dir so it is
/// testable without a Tauri handle.
fn write_discovery_file_at(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let payload = serde_json::json!({
        "port": MCP_PORT,
        "url": McpStatus::url_for(MCP_PORT),
    });
    std::fs::write(dir.join(SESSION_FILE), payload.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("dcs-mcp-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn discovery_file_carries_the_fixed_port_and_url() {
        let dir = temp_dir("discovery");
        write_discovery_file_at(&dir).expect("write");
        let persisted: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(SESSION_FILE)).expect("read"))
                .expect("json");
        assert_eq!(persisted["port"], serde_json::json!(MCP_PORT));
        assert_eq!(persisted["url"], "http://127.0.0.1:25570/mcp");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_taken_port_fails_closed() {
        // model FailsClosedOnPortClash (issue #39): when the port is already
        // held, the bind errs — never a random fallback — and maps to a
        // not-running status that still reports the intended fixed endpoint so
        // the setup modal can show it. An ephemeral port keeps the test from
        // racing a real IDE already bound to MCP_PORT.
        let held = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("hold a port");
        let port = held.local_addr().expect("addr").port();

        let message = bind_loopback(port).expect_err("a held port must fail closed");
        assert!(message.contains(&port.to_string()), "got {message}");

        let status = McpStatus::failed(message);
        assert!(!status.running, "a clash leaves the server not running");
        assert_eq!(status.port, MCP_PORT, "still reports the fixed port");
        assert!(status.error.is_some(), "carries the failure reason");
        assert_eq!(
            status.url,
            dcs_studio_project::mcp::url(),
            "still reports the intended endpoint for the modal"
        );
    }

    #[test]
    fn loopback_guard_allows_local_tools_and_blocks_rebinding() {
        // Local CLIs/editors: loopback Host, often no Origin.
        assert!(is_loopback_host("127.0.0.1:25570"));
        assert!(is_loopback_host("localhost:25570"));
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("[::1]:25570"));
        // A browser making a same-origin request to the surface.
        assert!(is_loopback_origin("http://127.0.0.1:25570"));
        assert!(is_loopback_origin("http://localhost:25570"));

        // DNS-rebinding: the attacker's hostname (resolved to 127.0.0.1) shows
        // up in Host/Origin — must be rejected.
        assert!(!is_loopback_host("evil.example.com:25570"));
        assert!(!is_loopback_origin("https://evil.example.com"));
        // A sandboxed page sends `Origin: null`.
        assert!(!is_loopback_origin("null"));
        // Lookalikes must not pass.
        assert!(!is_loopback_host("127.0.0.1.evil.com"));
        assert!(!is_loopback_host("localhostx"));
    }

    #[test]
    fn tool_result_maps_text_and_error_flag() {
        let ok = tool_result(&serde_json::json!({
            "content": [{ "type": "text", "text": "hello" }],
            "isError": false,
        }));
        assert_eq!(ok.is_error, Some(false));
        let err = tool_result(&serde_json::json!({
            "content": [{ "type": "text", "text": "boom" }],
            "isError": true,
        }));
        assert_eq!(err.is_error, Some(true));
    }
}
