// Browser-side JSON-RPC client for the in-DCS bridge WebSocket.
//
// In the packaged app DCS calls go through the Rust dcs-bridge-client
// (api.dcsCall -> invoke). When the UI runs in a plain browser (vite dev,
// Playwright e2e) there is no Tauri IPC, so dcsCall falls back to this client,
// which speaks the same wire protocol straight to ws://127.0.0.1:25569/ws.
//
// Wire shape per crates/dcs-bridge-client/src/protocol.rs: request `id` is a string or
// absent (never numeric), responses carry `result` or `error`.

const WS_URL = "ws://127.0.0.1:25569/ws";
// Server-side drain timeout is 5s; give the round trip a little headroom.
const CALL_TIMEOUT_MS = 10_000;

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let socket: WebSocket | null = null;
let opening: Promise<WebSocket> | null = null;
let nextId = 1;
const pending = new Map<string, Pending>();

/** Whether the socket is currently open (used for the browser status bar). */
export function wsConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN;
}

function failAllPending(reason: string) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  pending.clear();
}

function openSocket(): Promise<WebSocket> {
  if (socket && socket.readyState === WebSocket.OPEN) {
    return Promise.resolve(socket);
  }
  if (opening) return opening;

  opening = new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      socket = ws;
      opening = null;
      resolve(ws);
    };

    ws.onmessage = (event) => {
      let frame: { id?: string; result?: unknown; error?: JsonRpcError };
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!frame.id) return;
      const p = pending.get(frame.id);
      if (!p) return;
      pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.error) {
        const e = frame.error;
        p.reject(new Error(typeof e.data === "string" ? e.data : e.message));
      } else {
        p.resolve(frame.result ?? null);
      }
    };

    ws.onerror = () => {
      if (socket !== ws) {
        opening = null;
        reject(new Error(`DCS bridge unreachable at ${WS_URL}`));
      }
    };

    ws.onclose = () => {
      if (socket === ws) socket = null;
      opening = null;
      failAllPending("DCS bridge connection closed");
    };
  });
  return opening;
}

/** Send a JSON-RPC request and await its response. */
export async function wsCall(method: string, params?: unknown): Promise<unknown> {
  const ws = await openSocket();
  const id = String(nextId++);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`'${method}' timed out after ${CALL_TIMEOUT_MS}ms`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    ws.send(
      JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? null }),
    );
  });
}
