//! Shared test transport for the bridge's JSON-RPC server: a minimal blocking
//! WebSocket client and an equally minimal HTTP/1.1 client, both hand-rolled so
//! the suite needs no extra dependency to speak to a live bridge.
//!
//! Each integration test binary uses only part of this, hence the blanket
//! `dead_code` allow.

#![allow(dead_code)]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]
// The hand-rolled WS frame codec truncates lengths on purpose: test payloads are tiny.
#![allow(clippy::cast_possible_truncation)]

// Lua line coverage (#66). Must come AFTER the inner attributes above, or the
// module fails to parse.
pub mod lua_cov;

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

/// A tiny blocking WebSocket client (RFC 6455) — masked client frames out,
/// unmasked frames in — so the test needs no extra dependency. Enough to speak
/// JSON-RPC text frames to the bridge and read replies as they arrive.
pub struct Ws {
    stream: TcpStream,
    rx: Vec<u8>,
    /// Text frames already taken off the socket while waiting for something
    /// else (a Pong, a close), kept in order for `poll`/`await_id`.
    pending: VecDeque<String>,
    /// Pongs seen so far — the counter [`Ws::barrier`] waits on.
    pongs: u32,
    /// True once the peer has closed the connection (a Close frame, EOF, reset).
    closed: bool,
}

impl Ws {
    pub fn connect(port: u16) -> std::io::Result<Ws> {
        let mut stream = TcpStream::connect(("127.0.0.1", port))?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        let req = format!(
            "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n\
             Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
             Sec-WebSocket-Version: 13\r\n\r\n"
        );
        stream.write_all(req.as_bytes())?;

        let mut buf = Vec::new();
        let mut tmp = [0u8; 1024];
        loop {
            let n = stream.read(&mut tmp)?;
            if n == 0 {
                return Err(std::io::Error::other("closed during handshake"));
            }
            buf.extend_from_slice(&tmp[..n]);
            if let Some(pos) = find(&buf, b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..pos]);
                if !head.contains(" 101 ") {
                    return Err(std::io::Error::other(format!("handshake: {head}")));
                }
                let rx = buf[pos + 4..].to_vec(); // any frame bytes past the header
                return Ok(Ws {
                    stream,
                    rx,
                    pending: VecDeque::new(),
                    pongs: 0,
                    closed: false,
                });
            }
        }
    }

    pub fn send(&mut self, text: &str) -> std::io::Result<()> {
        let payload = text.as_bytes();
        let mut frame = vec![0x81u8]; // FIN + text
        let len = payload.len();
        if len < 126 {
            frame.push(0x80 | len as u8);
        } else if len < 65536 {
            frame.push(0x80 | 0x7e); // 126: 16-bit extended payload length
            frame.extend_from_slice(&(len as u16).to_be_bytes());
        } else {
            frame.push(0x80 | 0x7f); // 127: 64-bit extended payload length
            frame.extend_from_slice(&(len as u64).to_be_bytes());
        }
        let mask = [0x12u8, 0x34, 0x56, 0x78];
        frame.extend_from_slice(&mask);
        frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        self.stream.write_all(&frame)
    }

    /// Send a text frame of exactly `len` bytes of filler — the lever for the
    /// frame-size limit.
    ///
    /// It has to be a WHOLE frame: actix's WebSocket codec checks the length
    /// against its maximum only once the frame has arrived, so a header that
    /// merely *declares* an over-limit size is buffered rather than refused and
    /// would prove nothing. The payload is `len` zero bytes, which after masking
    /// is the mask key repeated — so this writes megabytes without building
    /// them byte by byte.
    pub fn send_filler_text(&mut self, len: usize) -> std::io::Result<()> {
        const MASK: [u8; 4] = [0x12, 0x34, 0x56, 0x78];
        let mut header = vec![0x81u8]; // FIN + text
        header.push(0x80 | 0x7f); // 127: 64-bit extended payload length
        header.extend_from_slice(&(len as u64).to_be_bytes());
        header.extend_from_slice(&MASK);
        self.stream.write_all(&header)?;

        let block: Vec<u8> = MASK.iter().copied().cycle().take(64 * 1024).collect();
        let mut written = 0;
        while written < len {
            let chunk = block.len().min(len - written);
            self.stream.write_all(&block[..chunk])?;
            written += chunk;
        }
        Ok(())
    }

    /// Send one masked frame with an arbitrary opcode — the lever for the
    /// control and binary frames the read loop has to handle.
    pub fn send_frame(&mut self, opcode: u8, payload: &[u8]) -> std::io::Result<()> {
        let mut frame = vec![0x80 | opcode];
        frame.push(0x80 | payload.len() as u8); // control frames are always short
        let mask = [0x12u8, 0x34, 0x56, 0x78];
        frame.extend_from_slice(&mask);
        frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        self.stream.write_all(&frame)
    }

    /// Send a Ping; the server must answer with a Pong.
    pub fn ping(&mut self, payload: &[u8]) -> std::io::Result<()> {
        self.send_frame(0x9, payload)
    }

    /// Send a Close; the server must echo it and end the read loop.
    pub fn close(&mut self) -> std::io::Result<()> {
        self.send_frame(0x8, &[])
    }

    /// Send a Binary frame — an opcode this server does not serve, so the read
    /// loop must end rather than misinterpret the payload.
    pub fn binary(&mut self, payload: &[u8]) -> std::io::Result<()> {
        self.send_frame(0x2, payload)
    }

    /// Read raw bytes for up to `wait`, returning what arrived. Used to observe
    /// control frames, which `poll` deliberately skips.
    pub fn read_raw(&mut self, wait: Duration) -> Vec<u8> {
        self.stream.set_read_timeout(Some(wait)).expect("timeout");
        let mut tmp = [0u8; 4096];
        match self.stream.read(&mut tmp) {
            Ok(n) => tmp[..n].to_vec(),
            Err(_) => Vec::new(),
        }
    }

    /// Poll until a text frame whose `id` matches arrives, or `wait` elapses.
    pub fn await_id(&mut self, id: &str, wait: Duration) -> Option<String> {
        let deadline = Instant::now() + wait;
        let needle = format!("\"id\":\"{id}\"");
        while Instant::now() < deadline {
            if let Some(message) = self.poll(Duration::from_millis(50)) {
                if message.contains(&needle) {
                    return Some(message);
                }
            }
        }
        None
    }

    /// Send a Ping and wait for its Pong: a barrier proving the server's read
    /// loop has already consumed every frame sent on this connection before it,
    /// since one connection's frames are read strictly in order.
    ///
    /// This is what a test waits on instead of sleeping. A sleep asserts nothing
    /// about the server — on a loaded runner the frames can still be unread when
    /// it expires, and a test whose next assertion is an ABSENCE (no answer
    /// arrives, no stale request is dropped) then passes for entirely the wrong
    /// reason, having exercised none of the path it exists to cover.
    pub fn barrier(&mut self, wait: Duration) -> bool {
        let before = self.pongs;
        self.ping(b"barrier").expect("ping");
        let deadline = Instant::now() + wait;
        while Instant::now() < deadline && !self.closed {
            self.fill(Duration::from_millis(50));
            self.drain_frames();
            if self.pongs > before {
                return true;
            }
        }
        false
    }

    /// Wait until the peer closes the connection (a Close frame, EOF or reset)
    /// — the positive form of "the server ended this session". The absence of a
    /// reply would look identical on a runner that has not read the frame yet.
    pub fn wait_until_closed(&mut self, wait: Duration) -> bool {
        let deadline = Instant::now() + wait;
        while Instant::now() < deadline && !self.closed {
            self.fill(Duration::from_millis(50));
            self.drain_frames();
        }
        self.closed
    }

    /// Read whatever has arrived into the frame buffer, waiting up to `wait`.
    /// EOF and a reset both mean the peer is gone.
    fn fill(&mut self, wait: Duration) {
        self.stream.set_read_timeout(Some(wait)).expect("timeout");
        let mut tmp = [0u8; 8192];
        match self.stream.read(&mut tmp) {
            Ok(0) => self.closed = true,
            Ok(n) => self.rx.extend_from_slice(&tmp[..n]),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => self.closed = true,
        }
    }

    /// Take every complete frame out of the buffer, queueing the text ones so a
    /// barrier never swallows a response `await_id` is about to look for.
    fn drain_frames(&mut self) {
        while let Some(text) = self.take_frame() {
            self.pending.push_back(text);
        }
    }

    /// Read one text message if one is available within `wait`, else None. A
    /// read that fails is the peer going away, which `fill` records as closed —
    /// indistinguishable from "nothing arrived" to a caller that is polling.
    pub fn poll(&mut self, wait: Duration) -> Option<String> {
        if let Some(m) = self.pending.pop_front() {
            return Some(m);
        }
        if let Some(m) = self.take_frame() {
            return Some(m);
        }
        self.fill(wait);
        self.take_frame()
    }

    /// Pull the next complete text frame from the buffer, skipping control
    /// frames; None when more bytes are needed.
    fn take_frame(&mut self) -> Option<String> {
        loop {
            if self.rx.len() < 2 {
                return None;
            }
            let (b0, b1) = (self.rx[0], self.rx[1]);
            let opcode = b0 & 0x0f;
            let masked = b1 & 0x80 != 0;
            let len7 = (b1 & 0x7f) as usize;
            let mut off = 2;
            let payload_len = match len7 {
                126 => {
                    if self.rx.len() < 4 {
                        return None;
                    }
                    off = 4;
                    u16::from_be_bytes([self.rx[2], self.rx[3]]) as usize
                }
                127 => {
                    if self.rx.len() < 10 {
                        return None;
                    }
                    off = 10;
                    let mut a = [0u8; 8];
                    a.copy_from_slice(&self.rx[2..10]);
                    u64::from_be_bytes(a) as usize
                }
                n => n,
            };
            let mask_len = if masked { 4 } else { 0 };
            let total = off + mask_len + payload_len;
            if self.rx.len() < total {
                return None;
            }
            let mask = masked.then(|| {
                [
                    self.rx[off],
                    self.rx[off + 1],
                    self.rx[off + 2],
                    self.rx[off + 3],
                ]
            });
            if masked {
                off += 4;
            }
            let mut payload = self.rx[off..off + payload_len].to_vec();
            if let Some(m) = mask {
                for (i, b) in payload.iter_mut().enumerate() {
                    *b ^= m[i % 4];
                }
            }
            self.rx.drain(..total);
            match opcode {
                0x1 => return Some(String::from_utf8_lossy(&payload).into_owned()),
                0x8 => {
                    self.closed = true; // close
                    return None;
                }
                0xa => self.pongs += 1, // the barrier's answer
                _ => {}                 // ping/binary: skip and try the next
            }
        }
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// A JSON-RPC request frame with a string id (the wire shape both bridges
/// speak — a numeric id fails serde on the server).
pub fn rpc(id: &str, method: &str, params: &str) -> String {
    format!(r#"{{"jsonrpc":"2.0","id":"{id}","method":"{method}","params":{params}}}"#)
}

/// A JSON-RPC notification frame (no id, so no response is expected).
pub fn notification(method: &str, params: &str) -> String {
    format!(r#"{{"jsonrpc":"2.0","method":"{method}","params":{params}}}"#)
}

/// A loopback port nothing is listening on right now. Binding and dropping is
/// the portable way to have the OS pick one; the small race with another
/// process is why the caller retries its connect.
pub fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
    listener.local_addr().expect("local addr").port()
}

/// Connect once the server has finished binding — `HttpServer::run` binds on
/// its own thread, so the first connect after `new` can legitimately fail.
pub fn connect_ws(port: u16) -> Ws {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match Ws::connect(port) {
            Ok(ws) => return ws,
            Err(e) if Instant::now() >= deadline => panic!("could not connect to the bridge: {e}"),
            Err(_) => std::thread::sleep(Duration::from_millis(25)),
        }
    }
}

/// One blocking HTTP/1.1 request against the bridge, returning
/// `(status line, body)`. Connection: close, so the body ends with the socket.
pub fn http(port: u16, request: &str) -> (String, String) {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut stream = loop {
        match TcpStream::connect(("127.0.0.1", port)) {
            Ok(s) => break s,
            Err(e) if Instant::now() >= deadline => panic!("could not connect: {e}"),
            Err(_) => std::thread::sleep(Duration::from_millis(25)),
        }
    };
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .expect("read timeout");
    stream.write_all(request.as_bytes()).expect("write request");

    let mut raw = String::new();
    stream.read_to_string(&mut raw).expect("read response");
    let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((raw.as_str(), ""));
    let status = head.lines().next().unwrap_or_default().to_string();
    (status, body.to_string())
}

/// A `POST /rpc` carrying `body` as JSON.
pub fn post_rpc(port: u16, body: &str) -> (String, String) {
    http(
        port,
        &format!(
            "POST /rpc HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ),
    )
}

/// A `GET <path>`.
pub fn get(port: u16, path: &str) -> (String, String) {
    http(
        port,
        &format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"),
    )
}
