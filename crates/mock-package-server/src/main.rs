//! The mock signing server binary: a minimal blocking HTTP loop over the pure
//! handler in `lib.rs`. Binds `127.0.0.1:<port>` (port from argv[1], default `0`
//! = ephemeral) and prints `listening http://127.0.0.1:<port>` so callers can
//! discover the address. For local dev and tests only — never production.

use std::io::Write;

use mock_package_server::{handle, State};

fn main() {
    let port: u16 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let server = tiny_http::Server::http(("127.0.0.1", port)).expect("bind mock signing server");
    let addr = server.server_addr();
    // The actual (possibly ephemeral) address, flushed so a parent process can
    // read it immediately.
    println!("listening http://{addr}");
    let _ = std::io::stdout().flush();

    let state = State::new();
    for mut request in server.incoming_requests() {
        let mut body = Vec::new();
        let _ = request.as_reader().read_to_end(&mut body);
        let path = request.url().split('?').next().unwrap_or("/").to_string();
        let (code, json) = handle(&path, &body, &state);
        let response = tiny_http::Response::from_string(json)
            .with_status_code(code)
            .with_header(
                tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
                    .expect("header"),
            );
        let _ = request.respond(response);
    }
}
