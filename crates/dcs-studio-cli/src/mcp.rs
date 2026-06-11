//! `dcs-studio-cli mcp` — Model Context Protocol over stdio
//! (newline-delimited JSON-RPC, protocol 2024-11-05). Tools:
//! `init_project`, `check`. Build/deploy/introspection tools follow their
//! phases (decisions/005).

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
                "description": "Scaffold a new DCS Studio project from a template (lua-script or blank). Creates <parent>/<name> with a dcs-studio.toml manifest and starter files.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "Project name; also the folder name" },
                        "parent": { "type": "string", "description": "Directory to create the project under" },
                        "template": { "type": "string", "enum": ["lua-script", "blank"], "description": "Template id (default lua-script)" }
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
            match crate::scaffold::init(template, Path::new(parent), project) {
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
        other => Err(format!("unknown tool: {other}")),
    }
}

fn tool_text(text: &str, is_error: bool) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error,
    })
}
