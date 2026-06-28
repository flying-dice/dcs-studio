# MCP server

DCS Studio hosts a Model Context Protocol (MCP) server inside the running IDE, exposing the IDE's own tools to LLM agents over standard MCP Streamable HTTP. Any MCP-capable editor or agent on the same machine can connect and drive the same project, file, build, and DCS operations the IDE itself uses.

## Loopback-only and unauthenticated

The server binds a fixed loopback endpoint — `http://127.0.0.1:25570/mcp` — and serves this machine alone. There is no token or password: it trusts the loopback-only bind to keep it private, and it rejects any request whose `Origin` or `Host` is not loopback. Because there is no credential, a connection is just a URL.

The port is fixed at **25570**, and the server *fails closed* if that port is already taken — it never falls back to a random port that nothing could have been configured for. If the bind fails, the rest of the IDE keeps running; free the port and restart the IDE to bring the server up.

## The status-bar indicator

The IDE's status bar (bottom-right) shows the server's state as a small MCP chip:

- green **MCP :25570** — serving on the fixed port;
- red **MCP: error** — the server could not bind (usually the port is in use);
- grey **MCP: off** — not started yet.

Click the chip at any time to open the **DCS Studio MCP server** setup help. The **Guides** index also links straight to it — under **More help**, choose **MCP server setup**.

## Connecting an editor

The setup help hands you a ready-to-use configuration for any MCP editor on the machine. When the server is running it confirms it is *"Serving on `http://127.0.0.1:25570/mcp`"*; if it is not, it notes that the fixed port must be free and to restart the IDE once it is. Each block has a **Copy** button.

**Claude Code (CLI)** — run this in any project to register the server:

```
claude mcp add --transport http dcs-studio http://127.0.0.1:25570/mcp
```

**Cursor · VS Code · Claude Desktop** — paste this into the editor's `mcp.json` / `.mcp.json`:

```json
{
  "mcpServers": {
    "dcs-studio": {
      "type": "http",
      "url": "http://127.0.0.1:25570/mcp"
    }
  }
}
```

**Manual entry** — for editors with a plain URL field:

```
http://127.0.0.1:25570/mcp
```

New projects are scaffolded with a `.mcp.json` already pointing at the server, so an agent opened inside a DCS Studio project reaches the tools with no setup. The snippets above are only for wiring up *other* editors on the machine.

## What an agent can do

The server's tools delegate to the very same services the IDE runs, so an agent and the IDE always behave identically. The surface includes project scaffolding, workspace file reads and writes, build and Lua analysis, and the DCS-linked operations — injecting the bridge, launching DCS, evaluating Lua in the running sim, and driving the in-sim debugger. The DCS tools run over the IDE's single already-open DCS link rather than dialling a second connection of their own.

Workspace file paths an agent reads or writes are absolute host paths used with your own rights — the MCP host you connect, not this server, owns tool-permission policy.

## Related

- The **Terminal** guide covers the built-in agentic harness profiles (Claude Code, OpenCode). When you launch one of those, the IDE exposes this server's loopback discovery path to the harness automatically, so it connects without the manual configuration above.

## Troubleshooting

- **Indicator red, or help shows "Not running"?** Another process is holding port 25570. Close whatever is using it — including a second DCS Studio instance, since only one IDE per machine can host the server — then restart the IDE.
- **Agent cannot connect?** Confirm the URL is exactly `http://127.0.0.1:25570/mcp`, and that the editor runs on the same machine. Remote and non-loopback origins are rejected by design.
