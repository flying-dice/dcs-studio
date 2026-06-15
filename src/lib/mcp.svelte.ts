// MCP server status singleton (model studio::mcp, issue #39).
//
// The IDE hosts its agent tool surface over standard MCP Streamable HTTP on a
// fixed loopback port. This store mirrors the backend `mcp_status` command for
// the status-bar indicator and the setup-help modal. The server binds at app
// boot (fail-closed on a port clash), so a single fetch on mount is enough —
// `refresh()` is exposed for an explicit re-check after the modal opens.
import { isTauri } from "@tauri-apps/api/core";
import { mcpStatus, type McpStatus } from "./api";

// The fixed loopback endpoint, kept in one place on the frontend (the backend's
// `dcs_studio_project::mcp` is the cross-language source of truth; this must
// match it). Used as the pre-fetch / non-Tauri default so the setup modal never
// re-hardcodes the port or URL.
export const DEFAULT_MCP_PORT = 25570;
export const DEFAULT_MCP_URL = `http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`;

class McpState {
  /** Whether the server bound the fixed port and is serving. */
  running = $state(false);
  /** The fixed port — reported even on failure so the modal shows the endpoint. */
  port = $state<number>(DEFAULT_MCP_PORT);
  /** The full Streamable HTTP endpoint, e.g. http://127.0.0.1:25570/mcp. */
  url = $state<string>(DEFAULT_MCP_URL);
  /** Why the server is not running (a port clash, …); null when serving. */
  error = $state<string | null>(null);
  /** False until the first status fetch resolves. */
  loaded = $state(false);

  /** Fetch the backend status once. No-op outside Tauri (plain browser dev has
   *  no IDE-hosted server). */
  async refresh(): Promise<void> {
    if (!isTauri()) {
      this.loaded = true;
      return;
    }
    try {
      const status: McpStatus = await mcpStatus();
      this.running = status.running;
      this.port = status.port;
      this.url = status.url;
      this.error = status.error;
    } catch (e) {
      this.running = false;
      this.error = String(e);
    } finally {
      this.loaded = true;
    }
  }
}

export const mcp = new McpState();
