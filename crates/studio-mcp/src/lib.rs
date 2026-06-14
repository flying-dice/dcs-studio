//! studio-mcp — the IDE's MCP tool surface (model/studio/mcp.pds, issue #33),
//! newline-delimited JSON-RPC (protocol 2024-11-05). Hosted by the running
//! app over a loopback transport sharing the app's live DCS link; also
//! drivable headless over stdio via [`serve`]. Tool groups:
//!
//! - project: `init_project`, `check`, `build`
//! - workspace fs: `read_dir`, `read_text_file`, `write_text_file`,
//!   `path_exists` (project creation is `init_project`)
//! - DCS link: `dcs_status`, `dcs_eval`, `dcs_call` — over the session's link;
//!   the app injects its already-open one ([`Session::with_link`]), a
//!   standalone session dials lazily on the first DCS tool call
//! - injection: `detect_installs`, `injection_status`, `inject`, `eject`
//! - mission scripting: `detect_mission_scripts`, `mission_script_status`,
//!   `mission_script_set`, `mission_script_restore`
//! - lang (the real dcs-lua engine): `lua_diagnostics`, `lua_hover`;
//!   `lua_complete` / `lua_definition` answer a stable not-implemented
//!   error until the engine grows those queries.
//!
//! Recorded decision (model/studio/mcp.pds): the workspace fs tools take
//! absolute host paths with no sandbox root, like the IDE fs commands they
//! delegate to — the server runs with the developer's own rights and the MCP
//! host owns tool-permission policy.

/// Workspace analysis shared by the `check` MCP tool and the CLI `check`
/// subcommand — renders the engine's findings and counts errors.
pub mod check;

use std::collections::HashMap;
use std::future::Future;
use std::io::{BufRead, Write};
use std::path::Path;
use std::sync::{Arc, OnceLock};

use serde_json::{Value, json};

use dcs_lua_lsp_core::workspace::Workspace;
use dcs_lua_syntax::{LineIndex, Severity};
use studio_services::link::{DCS_WS_URL, LinkShared};

/// Where the DCS tools dial: the bridge's well-known endpoint, overridable
/// via `DCS_BRIDGE_WS` so tests can pin a deterministically dead port even
/// on a machine with a live sim.
fn bridge_ws_url() -> String {
    std::env::var("DCS_BRIDGE_WS").unwrap_or_else(|_| DCS_WS_URL.to_string())
}

/// Per-session state: the DCS link, the bridge URL its DCS tools dial, and the
/// runtime that drives them. A `default` session dials `DCS_WS_URL`
/// (overridable via `DCS_BRIDGE_WS`) and never builds a link or runtime it
/// doesn't use; the app injects its already-open link via [`Session::with_link`]
/// and a test pins a fake bridge via [`Session::with_bridge_url`].
pub struct Session {
    link: Arc<LinkShared>,
    bridge_url: String,
    runtime: OnceLock<tokio::runtime::Runtime>,
}

impl Default for Session {
    fn default() -> Self {
        Session {
            link: Arc::default(),
            bridge_url: bridge_ws_url(),
            runtime: OnceLock::new(),
        }
    }
}

impl Session {
    /// Host the tools over `link` — the app passes its live, already-connected
    /// `LinkShared` so the DCS tools run on the one open connection instead of
    /// dialing a second one that would collide on the bridge (issue #33).
    #[must_use]
    pub fn with_link(link: Arc<LinkShared>) -> Self {
        Session {
            link,
            ..Session::default()
        }
    }

    /// Pin the bridge URL the DCS tools dial — for standalone/headless use and
    /// tests that drive a deterministic fake bridge.
    #[must_use]
    pub fn with_bridge_url(bridge_url: String) -> Self {
        Session {
            bridge_url,
            ..Session::default()
        }
    }

    fn block_on<T>(&self, future: impl Future<Output = T>) -> T {
        let runtime = self.runtime.get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .expect("tokio runtime construction cannot fail with default settings")
        });
        runtime.block_on(future)
    }
}

/// A tools/call failure that becomes a JSON-RPC error response: invalid
/// params (-32602) or a capability the engine does not have yet (-32601).
struct ToolError {
    code: i64,
    message: String,
}

impl ToolError {
    fn invalid(message: String) -> Self {
        ToolError {
            code: -32602,
            message,
        }
    }

    fn not_implemented(message: &str) -> Self {
        ToolError {
            code: -32601,
            message: message.to_string(),
        }
    }
}

/// Drive the handler over stdio (newline-delimited JSON-RPC) until the input
/// closes — the headless transport. The app hosts the surface differently,
/// calling [`handle`] over its loopback transport with a live-link session.
///
/// # Errors
/// Propagates an `io::Error` if reading a line from stdin or writing a
/// response to stdout fails.
pub fn serve() -> std::io::Result<()> {
    let session = Session::default();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue; // unparseable frames are ignored, the session lives on
        };
        let Some(response) = handle(&session, &message) else {
            continue; // notification — nothing to answer
        };
        serde_json::to_writer(&mut stdout, &response)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}

pub fn handle(session: &Session, message: &Value) -> Option<Value> {
    let method = message.get("method")?.as_str()?;
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    // Notifications (e.g. notifications/initialized) carry no id — and no
    // response.
    let id = message.get("id")?;
    let result = match method {
        "initialize" => json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": {
                "name": "dcs-studio-cli",
                "version": env!("CARGO_PKG_VERSION"),
            },
        }),
        "ping" => json!({}),
        "tools/list" => tools_list(),
        "tools/call" => match tools_call(session, &params) {
            Ok(result) => result,
            Err(error) => {
                return Some(error_response(id, error.code, &error.message));
            }
        },
        _ => {
            return Some(error_response(
                id,
                -32601,
                &format!("method not found: {method}"),
            ));
        }
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn error_response(id: &Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

// ---- tool registry ----------------------------------------------------------

fn tools_list() -> Value {
    let mut tools = project_tool_specs();
    tools.extend(workspace_tool_specs());
    tools.extend(dcs_tool_specs());
    tools.extend(inject_tool_specs());
    tools.extend(mission_tool_specs());
    tools.extend(lang_tool_specs());
    json!({ "tools": tools })
}

fn tools_call(session: &Session, params: &Value) -> Result<Value, ToolError> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::invalid("missing tool name".to_string()))?;
    let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
    let groups = [
        project_tools,
        workspace_tools,
        inject_tools,
        mission_tools,
        lang_tools,
    ];
    for group in groups {
        if let Some(result) = group(name, &arguments) {
            return result;
        }
    }
    if let Some(result) = dcs_tools(session, name, &arguments) {
        return result;
    }
    Err(ToolError::invalid(format!("unknown tool: {name}")))
}

/// Required string argument, or the invalid-params error naming the tool.
fn require_str<'a>(args: &'a Value, key: &str, tool: &str) -> Result<&'a str, ToolError> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::invalid(format!("{tool} requires '{key}'")))
}

/// Required non-negative integer argument.
fn require_u32(args: &Value, key: &str, tool: &str) -> Result<u32, ToolError> {
    args.get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| ToolError::invalid(format!("{tool} requires '{key}' (a non-negative integer)")))
}

fn tool_text(text: &str, is_error: bool) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error,
    })
}

/// A successful tool result whose payload is JSON, rendered as text.
fn tool_json(payload: &Value, is_error: bool) -> Value {
    let text = serde_json::to_string_pretty(payload).unwrap_or_else(|_| payload.to_string());
    tool_text(&text, is_error)
}

/// Serialize a service DTO into a successful JSON tool result.
fn tool_dto<T: serde::Serialize>(value: &T) -> Value {
    tool_json(&serde_json::to_value(value).unwrap_or(Value::Null), false)
}

/// A service `Result` rendered as a tool response: the status value as a DTO,
/// or the error message as a tool error. Shared by the inject and mission tool
/// groups, whose service calls both return `Result<impl Serialize, String>`.
fn status_or_error<T: serde::Serialize>(result: Result<T, String>) -> Value {
    match result {
        Ok(status) => tool_dto(&status),
        Err(message) => tool_text(&message, true),
    }
}

// ---- project tools (init_project / check / build) ---------------------------

fn project_tool_specs() -> Vec<Value> {
    vec![
        json!({
            "name": "init_project",
            "description": "Scaffold a new DCS Studio project from a template (lua-script, rust-dll, or blank). Creates <parent>/<name> with a dcs-studio.toml manifest and starter files.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Project name; also the folder name" },
                    "parent": { "type": "string", "description": "Directory to create the project under" },
                    "template": { "type": "string", "enum": ["lua-script", "rust-dll", "blank"], "description": "Template id (default lua-script)" }
                },
                "required": ["name", "parent"]
            }
        }),
        json!({
            "name": "check",
            "description": "Analyse every Lua source under a workspace root with the DCS Lua engine; returns findings as path:line:col with stable codes (LUA-Exxx).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "root": { "type": "string", "description": "Workspace root to analyse" }
                },
                "required": ["root"]
            }
        }),
        json!({
            "name": "build",
            "description": "Build the project at a root: runs `cargo build --release` for Rust projects (rust-dll) and reports a no-op for everything else. Returns the tail of the build output.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "root": { "type": "string", "description": "Project root to build" }
                },
                "required": ["root"]
            }
        }),
    ]
}

fn project_tools(name: &str, args: &Value) -> Option<Result<Value, ToolError>> {
    match name {
        "init_project" => Some(init_project_tool(args)),
        "check" => Some(require_str(args, "root", "check").map(|root| {
            let report = crate::check::run(Path::new(root));
            tool_text(&report.rendered, report.error_count > 0)
        })),
        "build" => Some(require_str(args, "root", "build").map(|root| build_tool(Path::new(root)))),
        _ => None,
    }
}

fn init_project_tool(args: &Value) -> Result<Value, ToolError> {
    let project = require_str(args, "name", "init_project")?;
    let parent = require_str(args, "parent", "init_project")?;
    let template = args
        .get("template")
        .and_then(Value::as_str)
        .unwrap_or("lua-script");
    match dcs_studio_project::scaffold::init(template, Path::new(parent), project) {
        Ok(root) => Ok(tool_text(&format!("created {}", root.display()), false)),
        Err(message) => Ok(tool_text(&message, true)),
    }
}

/// The `Build` subcommand's logic with captured (not inherited) output:
/// the agent gets the tail of the cargo transcript, not our stdio.
fn build_tool(root: &Path) -> Value {
    if !root.join("Cargo.toml").is_file() {
        return tool_text("no build step (not a Rust project)", false);
    }
    if dcs_studio_project::toolchain::detect().cargo.is_none() {
        return tool_text(
            "cargo not found — install the Rust toolchain via https://rustup.rs",
            true,
        );
    }
    match dcs_studio_project::quiet_command("cargo")
        .args(["build", "--release"])
        .current_dir(root)
        .output()
    {
        Ok(output) => {
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            tool_text(&tail_lines(&combined, 50), !output.status.success())
        }
        Err(error) => tool_text(&format!("running cargo: {error}"), true),
    }
}

/// Last `count` lines of `text` (cargo transcripts get long; the verdict
/// and errors live at the end).
fn tail_lines(text: &str, count: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(count)..].join("\n")
}

// ---- workspace fs tools ------------------------------------------------------

fn workspace_tool_specs() -> Vec<Value> {
    let path_only = |description: &str| {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": description }
            },
            "required": ["path"]
        })
    };
    vec![
        json!({
            "name": "read_dir",
            "description": "List a folder's immediate children, directories first then files, each group sorted case-insensitively.",
            "inputSchema": path_only("Folder to list")
        }),
        json!({
            "name": "read_text_file",
            "description": "Read a UTF-8 text file's contents.",
            "inputSchema": path_only("File to read")
        }),
        json!({
            "name": "write_text_file",
            "description": "Write contents to a text file, creating or truncating it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "File to write" },
                    "contents": { "type": "string", "description": "Full new file contents" }
                },
                "required": ["path", "contents"]
            }
        }),
        json!({
            "name": "path_exists",
            "description": "Whether a path currently exists on disk.",
            "inputSchema": path_only("Path to probe")
        }),
    ]
}

fn workspace_tools(name: &str, args: &Value) -> Option<Result<Value, ToolError>> {
    match name {
        "read_dir" => Some(require_str(args, "path", "read_dir").map(|path| {
            match studio_services::fs::read_dir(path) {
                Ok(entries) => tool_dto(&entries),
                Err(message) => tool_text(&message, true),
            }
        })),
        "read_text_file" => Some(require_str(args, "path", "read_text_file").map(|path| {
            match studio_services::fs::read_text_file(path) {
                Ok(contents) => tool_text(&contents, false),
                Err(message) => tool_text(&message, true),
            }
        })),
        "write_text_file" => Some(write_text_file_tool(args)),
        "path_exists" => Some(require_str(args, "path", "path_exists").map(|path| {
            tool_json(&json!(studio_services::fs::path_exists(path)), false)
        })),
        _ => None,
    }
}

fn write_text_file_tool(args: &Value) -> Result<Value, ToolError> {
    let path = require_str(args, "path", "write_text_file")?;
    let contents = require_str(args, "contents", "write_text_file")?;
    Ok(
        match studio_services::fs::write_text_file(path, contents) {
            Ok(()) => tool_text(&format!("wrote {path}"), false),
            Err(message) => tool_text(&message, true),
        },
    )
}

// ---- DCS link tools ----------------------------------------------------------

fn dcs_tool_specs() -> Vec<Value> {
    vec![
        json!({
            "name": "dcs_status",
            "description": "Probe the editor<->DCS link with an on-demand ping. Works without DCS (connected: false). sim_running is true only once the pong's dcs_time advances past 0 — the bridge answers from the main menu too.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "dcs_eval",
            "description": "Run a Lua snippet inside the DCS GUI/hooks environment via the injected bridge and return its result.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "code": { "type": "string", "description": "Lua source to evaluate" }
                },
                "required": ["code"]
            }
        }),
        json!({
            "name": "dcs_call",
            "description": "Forward an arbitrary JSON-RPC method (with optional params) to the in-DCS bridge.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "method": { "type": "string", "description": "JSON-RPC method name (e.g. ping, eval)" },
                    "params": { "description": "Optional JSON params for the method" }
                },
                "required": ["method"]
            }
        }),
    ]
}

fn dcs_tools(session: &Session, name: &str, args: &Value) -> Option<Result<Value, ToolError>> {
    match name {
        "dcs_status" => Some(Ok(dcs_status_tool(session))),
        "dcs_eval" => Some(dcs_eval_tool(session, args)),
        "dcs_call" => Some(dcs_call_tool(session, args)),
        _ => None,
    }
}

fn dcs_status_tool(session: &Session) -> Value {
    let url = session.bridge_url.clone();
    let status = session.block_on(async {
        session.link.ensure_client(&url).await;
        session.link.status_live().await
    });
    tool_json(&status, false)
}

fn dcs_eval_tool(session: &Session, args: &Value) -> Result<Value, ToolError> {
    let code = require_str(args, "code", "dcs_eval")?;
    Ok(forward_to_dcs(session, "eval", Some(json!({ "code": code }))))
}

fn dcs_call_tool(session: &Session, args: &Value) -> Result<Value, ToolError> {
    let method = require_str(args, "method", "dcs_call")?;
    let params = args.get("params").filter(|p| !p.is_null()).cloned();
    Ok(forward_to_dcs(session, method, params))
}

/// Dial the bridge lazily, then forward one call; link errors (the
/// not-started guard, not-connected, RPC failures) come back as tool errors.
fn forward_to_dcs(session: &Session, method: &str, params: Option<Value>) -> Value {
    let url = session.bridge_url.clone();
    let result = session.block_on(async {
        session.link.ensure_client(&url).await;
        session.link.call(method, params).await
    });
    match result {
        Ok(value) => tool_json(&value, false),
        Err(message) => tool_text(&message, true),
    }
}

// ---- injection tools ---------------------------------------------------------

fn inject_tool_specs() -> Vec<Value> {
    let write_dir_only = json!({
        "type": "object",
        "properties": {
            "write_dir": { "type": "string", "description": "DCS Saved Games write dir (from detect_installs)" }
        },
        "required": ["write_dir"]
    });
    vec![
        json!({
            "name": "detect_installs",
            "description": "Scan Saved Games for DCS write dirs (DCS or DCS.*); valid means the dir carries a Config subdir. Plain DCS sorts first.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "injection_status",
            "description": "What of the in-DCS bridge (DLL + GameGUI hook) is installed in a write dir, vs the artifacts this build would install.",
            "inputSchema": write_dir_only.clone()
        }),
        json!({
            "name": "inject",
            "description": "Install or update the bridge DLL + hook into a DCS write dir. Fails when no source DLL is built or the installed DLL is locked by a running DCS.",
            "inputSchema": write_dir_only.clone()
        }),
        json!({
            "name": "eject",
            "description": "Remove the bridge DLL + hook from a DCS write dir (missing files are fine).",
            "inputSchema": write_dir_only
        }),
    ]
}

fn inject_tools(name: &str, args: &Value) -> Option<Result<Value, ToolError>> {
    match name {
        "detect_installs" => Some(Ok(tool_dto(&studio_services::inject::detect_installs()))),
        "injection_status" => Some(
            require_str(args, "write_dir", "injection_status")
                .map(|dir| tool_dto(&studio_services::inject::injection_status(dir))),
        ),
        "inject" => Some(
            require_str(args, "write_dir", "inject")
                .map(|dir| status_or_error(studio_services::inject::inject(dir))),
        ),
        "eject" => Some(
            require_str(args, "write_dir", "eject")
                .map(|dir| status_or_error(studio_services::inject::eject(dir))),
        ),
        _ => None,
    }
}

// ---- mission scripting tools ---------------------------------------------------

fn mission_tool_specs() -> Vec<Value> {
    let path_only = json!({
        "type": "object",
        "properties": {
            "path": { "type": "string", "description": "Path to MissionScripting.lua (from detect_mission_scripts)" }
        },
        "required": ["path"]
    });
    vec![
        json!({
            "name": "detect_mission_scripts",
            "description": "Find candidate MissionScripting.lua files: Eagle Dynamics registry installs first, then Program Files probes; deduped. A machine with no DCS yields an empty list.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "mission_script_status",
            "description": "A MissionScripting.lua's sanitization snapshot: per-item present/sanitized state, writability, backup presence.",
            "inputSchema": path_only.clone()
        }),
        json!({
            "name": "mission_script_set",
            "description": "Set the desired sanitized state per item ({\"lfs\": false} = desanitize lfs). Only matching lines toggle; the first modification snapshots a pristine backup.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Path to MissionScripting.lua" },
                    "items": {
                        "type": "object",
                        "description": "Item name (os, io, lfs, require, loadlib, package) -> desired sanitized state",
                        "additionalProperties": { "type": "boolean" }
                    }
                },
                "required": ["path", "items"]
            }
        }),
        json!({
            "name": "mission_script_restore",
            "description": "Copy the pristine <path>.dcsstudio.bak backup back over the live MissionScripting.lua.",
            "inputSchema": path_only
        }),
    ]
}

fn mission_tools(name: &str, args: &Value) -> Option<Result<Value, ToolError>> {
    match name {
        "detect_mission_scripts" => Some(Ok(tool_dto(
            &studio_services::mission::detect_mission_scripts(),
        ))),
        "mission_script_status" => Some(
            require_str(args, "path", "mission_script_status")
                .map(|path| tool_dto(&studio_services::mission::mission_script_status(path))),
        ),
        "mission_script_set" => Some(mission_script_set_tool(args)),
        "mission_script_restore" => Some(
            require_str(args, "path", "mission_script_restore")
                .map(|path| status_or_error(studio_services::mission::restore(path))),
        ),
        _ => None,
    }
}

fn mission_script_set_tool(args: &Value) -> Result<Value, ToolError> {
    let path = require_str(args, "path", "mission_script_set")?;
    let items: HashMap<String, bool> =
        serde_json::from_value(args.get("items").cloned().unwrap_or(Value::Null)).map_err(|e| {
            ToolError::invalid(format!(
                "mission_script_set requires 'items' as an object of item -> bool: {e}"
            ))
        })?;
    Ok(match studio_services::mission::set_items(path, &items) {
        Ok(status) => tool_dto(&status),
        Err(message) => tool_text(&message, true),
    })
}

// ---- lang tools (the real dcs-lua engine) -------------------------------------

fn lang_tool_specs() -> Vec<Value> {
    let position_schema = json!({
        "type": "object",
        "properties": {
            "root": { "type": "string", "description": "Workspace root to mount" },
            "path": { "type": "string", "description": "Lua file within the root" },
            "line": { "type": "integer", "description": "1-based line" },
            "character": { "type": "integer", "description": "1-based column (bytes)" }
        },
        "required": ["root", "path", "line", "character"]
    });
    vec![
        json!({
            "name": "lua_diagnostics",
            "description": "Mount every Lua source under a root into the DCS Lua engine and return all findings as JSON (path, 1-based line/character, severity, stable code, message).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "root": { "type": "string", "description": "Workspace root to analyse" }
                },
                "required": ["root"]
            }
        }),
        json!({
            "name": "lua_hover",
            "description": "The engine's hover card (declaration headline + docs) for the identifier at a 1-based line/character in a Lua file under the root.",
            "inputSchema": position_schema.clone()
        }),
        json!({
            "name": "lua_complete",
            "description": "Completion suggestions. Not implemented in the engine yet — answers a stable JSON-RPC error so the contract holds.",
            "inputSchema": position_schema.clone()
        }),
        json!({
            "name": "lua_definition",
            "description": "Go-to-definition. Not implemented in the engine yet — answers a stable JSON-RPC error so the contract holds.",
            "inputSchema": position_schema
        }),
    ]
}

fn lang_tools(name: &str, args: &Value) -> Option<Result<Value, ToolError>> {
    match name {
        "lua_diagnostics" => Some(
            require_str(args, "root", "lua_diagnostics")
                .map(|root| lua_diagnostics_tool(Path::new(root))),
        ),
        "lua_hover" => Some(lua_hover_tool(args)),
        "lua_complete" => Some(Err(ToolError::not_implemented(
            "lua_complete: completion is not implemented in the engine yet",
        ))),
        "lua_definition" => Some(Err(ToolError::not_implemented(
            "lua_definition: go-to-definition is not implemented in the engine yet",
        ))),
        _ => None,
    }
}

fn severity_name(severity: Severity) -> &'static str {
    match severity {
        Severity::Error => "error",
        Severity::Warning => "warning",
        Severity::Info => "info",
    }
}

/// Mount the root and report every engine finding, structured.
fn lua_diagnostics_tool(root: &Path) -> Value {
    let files = dcs_studio_project::sources::collect(root);
    let mut workspace = Workspace::new();
    for (path, text) in &files {
        workspace.set_source(path, text);
    }
    workspace.set_lint_levels(dcs_lua_lsp_core::lints::levels_from_strings(
        &dcs_studio_project::manifest::lua_lint_levels(root),
    ));
    let findings = dcs_lua_lsp_core::all_findings(&workspace);
    let rendered: Vec<Value> = findings
        .iter()
        .map(|(path, diagnostic)| {
            let (line, character) = workspace.file(path).map_or((1, 1), |entry| {
                LineIndex::new(&entry.source).line_col(diagnostic.span.start)
            });
            json!({
                "path": path,
                "line": line,
                "character": character,
                "severity": severity_name(diagnostic.severity),
                "code": diagnostic.code,
                "message": diagnostic.message,
            })
        })
        .collect();
    tool_json(
        &json!({ "files_checked": files.len(), "findings": rendered }),
        false,
    )
}

/// The engine's hover card at a 1-based line/character.
fn lua_hover_tool(args: &Value) -> Result<Value, ToolError> {
    let root = require_str(args, "root", "lua_hover")?;
    let path = require_str(args, "path", "lua_hover")?;
    let line = require_u32(args, "line", "lua_hover")?;
    let character = require_u32(args, "character", "lua_hover")?;

    let files = dcs_studio_project::sources::collect(Path::new(root));
    let mut workspace = Workspace::new();
    for (file_path, text) in &files {
        workspace.set_source(file_path, text);
    }
    let Some(key) = workspace_key(&workspace, path) else {
        return Ok(tool_text(
            &format!("'{path}' is not a Lua source under '{root}'"),
            true,
        ));
    };
    let source = workspace
        .file(&key)
        .map(|entry| entry.source.clone())
        .unwrap_or_default();
    let offset = offset_at(&source, line, character);
    Ok(match dcs_lua_lsp_core::hover(&workspace, &key, offset) {
        Some(info) => tool_json(&json!({ "title": info.title, "body": info.body }), false),
        None => tool_text("no hover information at this position", false),
    })
}

/// Resolve the workspace key for `path`: an exact key first, then
/// component-wise path equality so `/` and `\` spellings both land.
fn workspace_key(workspace: &Workspace, path: &str) -> Option<String> {
    if workspace.file(path).is_some() {
        return Some(path.to_string());
    }
    workspace
        .files()
        .map(|(key, _)| key)
        .find(|key| Path::new(key) == Path::new(path))
        .map(str::to_string)
}

/// Byte offset of a 1-based line/column pair; clamps past-end values.
fn offset_at(source: &str, line: u32, character: u32) -> u32 {
    let mut offset = 0u32;
    for (index, text) in source.split('\n').enumerate() {
        if index as u32 + 1 == line {
            return offset + character.saturating_sub(1).min(text.len() as u32);
        }
        offset += text.len() as u32 + 1;
    }
    source.len() as u32
}

#[cfg(test)]
mod tests {
    use super::offset_at;

    #[test]
    fn offset_at_maps_one_based_positions_to_byte_offsets() {
        let source = "local a = 1\nprint(a)\n";
        assert_eq!(offset_at(source, 1, 1), 0);
        assert_eq!(offset_at(source, 1, 7), 6); // the `a` in `local a`
        assert_eq!(offset_at(source, 2, 7), 18); // the `a` in `print(a)`
    }

    #[test]
    fn offset_at_clamps_past_the_line_and_the_file() {
        let source = "ab\ncd";
        assert_eq!(offset_at(source, 1, 99), 2); // clamped to end of line 1
        assert_eq!(offset_at(source, 99, 1), 5); // clamped to end of file
    }
}
