//! App-hosted MCP server (issue #33): the IDE exposes its tool surface to
//! local agents over a loopback TCP socket, dispatching through
//! `studio_mcp::handle` with the app's LIVE DCS link — so an agent and the IDE
//! share the one open connection to the sim instead of a sidecar dialing a
//! second (which would collide on the bridge).
//!
//! Two guards, because the surface includes `dcs_eval` (arbitrary Lua into the
//! running sim): the listener binds loopback only, and a per-launch random
//! token must be presented on the first line before any tool call. The token
//! and port are written to `<app-config>/mcp.json`, readable by the agent the
//! developer runs — never put on the wire by us.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;

use serde_json::{Value, json};
use studio_mcp::{Session, handle};
use studio_services::link::LinkShared;
use tauri::{AppHandle, Manager};

/// Where the agent reads `{ port, token }` from — beside the app's other
/// config, in the per-user config dir.
const SESSION_FILE: &str = "mcp.json";

/// Start the loopback MCP server. Non-fatal on any failure (no RNG, port in
/// use, unwritable config dir): the IDE works on, agents just can't attach.
pub fn start(app: &AppHandle) {
    let link = app.state::<crate::dcs::DcsState>().link();
    let Some(token) = generate_token() else {
        tracing::warn!("mcp: no OS randomness — loopback server not started");
        return;
    };
    let listener = match TcpListener::bind(("127.0.0.1", 0)) {
        Ok(listener) => listener,
        Err(error) => {
            tracing::warn!(%error, "mcp: loopback bind failed — server not started");
            return;
        }
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(error) => {
            tracing::warn!(%error, "mcp: no local addr — server not started");
            return;
        }
    };
    if let Err(error) = write_session_file(app, port, &token) {
        // The server still serves; agents just won't discover it automatically.
        tracing::warn!(%error, "mcp: could not write session file");
    }
    tracing::info!(port, "mcp: loopback server listening");
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let link = link.clone();
            let token = token.clone();
            std::thread::spawn(move || {
                if let Err(error) = serve_conn(&stream, link, &token) {
                    tracing::debug!(%error, "mcp: connection ended");
                }
            });
        }
    });
}

/// Serve one connection: the first line must authenticate, then every
/// newline-framed JSON-RPC message dispatches through the shared handler over
/// the app's live link. The `Session` is per-connection; the link is shared.
fn serve_conn(stream: &TcpStream, link: Arc<LinkShared>, token: &str) -> std::io::Result<()> {
    let session = Session::with_link(link);
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut writer = stream.try_clone()?;
    let mut authed = false;
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(()); // peer closed
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
            continue; // unparseable frame — the connection lives on
        };
        if !authed {
            let id = message.get("id").cloned().unwrap_or(Value::Null);
            if is_valid_auth(&message, token) {
                authed = true;
                let ok = json!({ "jsonrpc": "2.0", "id": id, "result": { "authenticated": true } });
                writeln!(writer, "{ok}")?;
                continue;
            }
            // One chance: a bad or missing token closes the connection.
            let err = json!({
                "jsonrpc": "2.0", "id": id,
                "error": { "code": -32001, "message": "authentication required: send { method: authenticate, params: { token } } first" },
            });
            writeln!(writer, "{err}")?;
            return Ok(());
        }
        if let Some(response) = handle(&session, &message) {
            writeln!(writer, "{response}")?;
        }
    }
}

/// The first message must be `{ "method": "authenticate", "params": { "token": <session token> } }`.
fn is_valid_auth(message: &Value, token: &str) -> bool {
    message.get("method").and_then(Value::as_str) == Some("authenticate")
        && message
            .get("params")
            .and_then(|params| params.get("token"))
            .and_then(Value::as_str)
            == Some(token)
}

/// 32 hex chars of OS randomness; `None` if the OS has no entropy source.
fn generate_token() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).ok()?;
    Some(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Write `{ port, token }` to `<app-config>/mcp.json` for the agent to read.
fn write_session_file(app: &AppHandle, port: u16, token: &str) -> std::io::Result<()> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    std::fs::create_dir_all(&dir)?;
    let payload = json!({ "port": port, "token": token });
    std::fs::write(dir.join(SESSION_FILE), payload.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufRead;

    /// A connected loopback socket pair: (client, accepted server side).
    fn loopback_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        let client = TcpStream::connect(addr).expect("connect");
        let (server, _) = listener.accept().expect("accept");
        (client, server)
    }

    fn read_json(reader: &mut impl BufRead) -> Value {
        let mut line = String::new();
        reader.read_line(&mut line).expect("read");
        serde_json::from_str(line.trim()).expect("json")
    }

    /// Serve `server` on a thread with token "secret" over a fresh (unused)
    /// link, returning the join handle so the test can await a clean close.
    fn serve(server: TcpStream) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let _ = serve_conn(&server, Arc::new(LinkShared::default()), "secret");
        })
    }

    #[test]
    fn generate_token_is_32_hex_chars_and_unpredictable() {
        let a = generate_token().expect("os randomness");
        let b = generate_token().expect("os randomness");
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "two tokens must differ");
    }

    #[test]
    fn is_valid_auth_demands_the_exact_token() {
        let good = json!({"method": "authenticate", "params": {"token": "secret"}});
        assert!(is_valid_auth(&good, "secret"));
        assert!(!is_valid_auth(&good, "other"));
        assert!(!is_valid_auth(&json!({"method": "authenticate", "params": {}}), "secret"));
        assert!(!is_valid_auth(&json!({"method": "tools/list"}), "secret"));
    }

    /// Assert the server closed the connection: the next read sees the close.
    /// A graceful close is `Ok(0)` (EOF after a FIN); under load the server can
    /// instead drop its socket while our blocking read is already armed, which
    /// surfaces as a TCP RST — `ConnectionReset`/`ConnectionAborted`. Both mean
    /// "closed"; accept either. The caller must have armed a read timeout first,
    /// so a genuine still-open socket fails fast with `WouldBlock`/`TimedOut`
    /// rather than hanging the suite (a test hang reads as a stall, not a
    /// failure).
    fn assert_connection_closed(reader: &mut impl BufRead) {
        use std::io::ErrorKind::{ConnectionAborted, ConnectionReset};
        let mut tail = String::new();
        match reader.read_line(&mut tail) {
            Ok(0) => {}
            Err(error) if matches!(error.kind(), ConnectionReset | ConnectionAborted) => {}
            other => panic!("expected the server to close the connection, got {other:?}"),
        }
    }

    #[test]
    fn a_bad_token_is_rejected_and_the_connection_closes() {
        let (client, server) = loopback_pair();
        let handle = serve(server);
        let mut writer = client.try_clone().expect("clone");
        // Arm a read timeout on the stream the reader wraps, so a non-closing
        // regression fails this test in 2s rather than hanging the suite.
        client
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .expect("set read timeout");
        let mut reader = BufReader::new(client);

        writeln!(
            writer,
            r#"{{"jsonrpc":"2.0","id":1,"method":"authenticate","params":{{"token":"wrong"}}}}"#
        )
        .expect("write");
        let resp = read_json(&mut reader);
        assert_eq!(resp["error"]["code"], json!(-32001));

        // The server closed the connection — the next read is EOF.
        assert_connection_closed(&mut reader);
        handle.join().expect("server thread");
    }

    #[test]
    fn an_unauthenticated_tool_call_never_reaches_the_handler() {
        let (client, server) = loopback_pair();
        let handle = serve(server);
        let mut writer = client.try_clone().expect("clone");
        client
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .expect("set read timeout");
        let mut reader = BufReader::new(client);

        // Skipping auth and going straight for a tool is refused, not served.
        writeln!(writer, r#"{{"jsonrpc":"2.0","id":1,"method":"tools/list"}}"#).expect("write");
        let resp = read_json(&mut reader);
        assert_eq!(resp["error"]["code"], json!(-32001));
        // And, like any failed auth, the server then closes the connection —
        // it never loops back to read a second (now-"authed") line.
        assert_connection_closed(&mut reader);
        handle.join().expect("server thread");
    }

    /// A `BufRead` whose read always fails with `kind` — stands in for a socket
    /// that reports a close (or a still-open timeout) without a live peer.
    struct FailingReader(std::io::ErrorKind);
    impl std::io::Read for FailingReader {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(self.0.into())
        }
    }
    impl BufRead for FailingReader {
        fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
            Err(self.0.into())
        }
        fn consume(&mut self, _: usize) {}
    }

    #[test]
    fn assert_connection_closed_accepts_an_abortive_reset() {
        // An abortive close (RST) surfaces as ConnectionReset/Aborted, not EOF —
        // under load the server can drop its socket while our read is armed.
        // Both are "closed"; neither must panic.
        assert_connection_closed(&mut FailingReader(std::io::ErrorKind::ConnectionReset));
        assert_connection_closed(&mut FailingReader(std::io::ErrorKind::ConnectionAborted));
    }

    #[test]
    #[should_panic(expected = "expected the server to close the connection")]
    fn assert_connection_closed_still_rejects_a_live_socket() {
        // The pin that keeps the reset-acceptance from going vacuous: a genuinely
        // open socket times out (WouldBlock/TimedOut under the armed read
        // timeout) and MUST still fail loudly, not be mistaken for a close.
        assert_connection_closed(&mut FailingReader(std::io::ErrorKind::WouldBlock));
    }

    #[test]
    fn a_valid_token_unlocks_the_full_tool_surface() {
        let (client, server) = loopback_pair();
        let handle = serve(server);
        let mut writer = client.try_clone().expect("clone");
        let mut reader = BufReader::new(client);

        writeln!(
            writer,
            r#"{{"jsonrpc":"2.0","id":1,"method":"authenticate","params":{{"token":"secret"}}}}"#
        )
        .expect("write");
        let auth = read_json(&mut reader);
        assert_eq!(auth["result"]["authenticated"], json!(true));

        writeln!(writer, r#"{{"jsonrpc":"2.0","id":2,"method":"tools/list"}}"#).expect("write");
        let tools = read_json(&mut reader);
        assert_eq!(
            tools["result"]["tools"].as_array().expect("tools").len(),
            22,
            "the full issue-#8 surface stays reachable through the app server"
        );

        // Closing the socket ends the server's read loop. Dropping one clone
        // is not enough — the reader clone still holds the connection open, so
        // shut the whole socket down explicitly.
        writer
            .shutdown(std::net::Shutdown::Both)
            .expect("shutdown");
        handle.join().expect("server thread");
    }
}
