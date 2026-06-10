// Shared DCS-side helpers for the e2e suite: bridge endpoints + readiness.

export const BRIDGE_HTTP = "http://127.0.0.1:25569";

/** Default install path on this machine; override with the DCS_EXE env var. */
export const DCS_EXE =
  process.env.DCS_EXE ??
  "D:\\Program Files\\Eagle Dynamics\\DCS World OpenBeta\\bin\\DCS.exe";

export async function bridgeHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_HTTP}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Fire a JSON-RPC notification (no id, no reply expected) at the bridge. */
export async function rpcNotify(method: string, params?: unknown): Promise<void> {
  await fetch(`${BRIDGE_HTTP}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    signal: AbortSignal.timeout(5_000),
  });
}
