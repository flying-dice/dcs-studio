//! `dcs-studio-cli mcp` — Model Context Protocol over stdio
//! (newline-delimited JSON-RPC, protocol 2024-11-05). Tools:
//! `init_project`, `check`, `build`. Deploy/introspection tools follow
//! their phases (decisions/005).

use std::io::{BufRead, Write};
use std::path::Path;

use serde_json::{Value, json};

pub fn serve() -> std::io::Result<()> {
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
        let Some(response) = handle(&message) else {
            continue; // notification — nothing to answer
        };
        serde_json::to_writer(&mut stdout, &response)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}

fn handle(message: &Value) -> Option<Value> {
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
        "tools/call" => match tools_call(&params) {
            Ok(result) => result,
            Err(message) => {
                return Some(error_response(id, -32602, &message));
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

fn tools_list() -> Value {
    json!({
        "tools": [
            {
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
            },
            {
                "name": "check",
                "description": "Analyse every Lua source under a workspace root with the DCS Lua engine; returns findings as path:line:col with stable codes (LUA-Exxx).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "root": { "type": "string", "description": "Workspace root to analyse" }
                    },
                    "required": ["root"]
                }
            },
            {
                "name": "build",
                "description": "Build the project at a root: runs `cargo build --release` for Rust projects (rust-dll) and reports a no-op for everything else. Returns the tail of the build output.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "root": { "type": "string", "description": "Project root to build" }
                    },
                    "required": ["root"]
                }
            }
        ]
    })
}

fn tools_call(params: &Value) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or("missing tool name")?;
    let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
    match name {
        "init_project" => {
            let project = arguments
                .get("name")
                .and_then(Value::as_str)
                .ok_or("init_project requires 'name'")?;
            let parent = arguments
                .get("parent")
                .and_then(Value::as_str)
                .ok_or("init_project requires 'parent'")?;
            let template = arguments
                .get("template")
                .and_then(Value::as_str)
                .unwrap_or("lua-script");
            match dcs_studio_project::scaffold::init(template, Path::new(parent), project) {
                Ok(root) => Ok(tool_text(&format!("created {}", root.display()), false)),
                Err(message) => Ok(tool_text(&message, true)),
            }
        }
        "check" => {
            let root = arguments
                .get("root")
                .and_then(Value::as_str)
                .ok_or("check requires 'root'")?;
            let report = crate::check::run(Path::new(root));
            Ok(tool_text(&report.rendered, report.error_count > 0))
        }
        "build" => {
            let root = arguments
                .get("root")
                .and_then(Value::as_str)
                .ok_or("build requires 'root'")?;
            Ok(build_tool(Path::new(root)))
        }
        other => Err(format!("unknown tool: {other}")),
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

fn tool_text(text: &str, is_error: bool) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error,
    })
}
