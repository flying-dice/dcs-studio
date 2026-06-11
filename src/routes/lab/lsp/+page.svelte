<script lang="ts">
  // Browser test surface for the PRODUCTION LSP client path — the exact
  // `LspClient` + `LuaAnalyzerProvider` classes the packaged app uses — over an
  // injected in-page transport that behaves like `dcs-studio-cli lsp` on
  // the wire (framed JSON-RPC, request/response, publishDiagnostics push).
  // Covers what only the Tauri runtime would otherwise reach: request
  // correlation, UTF-16 position conversion on non-ASCII text, and the
  // crash path (server exit → pending requests rejected → engine failed).
  import { onMount } from "svelte";
  import { LspClient, type LspTransport } from "$lib/lang/lsp-client";
  import { LuaAnalyzerProvider } from "$lib/lang/lua-analyzer";
  import type { Diagnostic } from "$lib/lang/provider";

  const PATH = "C:\\lab\\main.lua";
  // Cyrillic + ellipsis before the error: byte ≠ UTF-16 territory.
  const BROKEN = "-- наводка по цели…\nfunction f(\n";

  let findings = $state<Diagnostic[]>([]);
  let markedText = $state("");
  let serverAlive = $state(true);
  let afterCrashError = $state("");
  let ready = $state(false);
  // Did the client answer our server→client request (id 999)?
  let serverReq = $state("pending");
  let hoverTitle = $state("");
  let hoverBody = $state("");

  // ---- the fake server ------------------------------------------------
  // The crash button kills the CURRENT server; each connect() builds a
  // fresh transport (fresh emit fns), like the host respawning the CLI.
  let emitExit: () => void = () => {};

  function lineCharOf(text: string, index: number): { line: number; character: number } {
    const before = text.slice(0, index);
    const line = before.split("\n").length - 1;
    const character = index - (before.lastIndexOf("\n") + 1);
    return { line, character };
  }

  function diagnosticsFor(uri: string, text: string): string {
    const at = text.indexOf("function f(");
    const diagnostics =
      at < 0
        ? []
        : [
            {
              range: {
                start: lineCharOf(text, text.indexOf("(", at)),
                end: lineCharOf(text, text.indexOf("(", at) + 1),
              },
              severity: 1,
              code: "LUA-E102",
              message: "unterminated 'function' block: 'end' expected",
            },
          ];
    return JSON.stringify({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, diagnostics },
    });
  }

  function makeTransport(): LspTransport {
    let emitMessage: (raw: string) => void = () => {};
    return {
      async start(onMessage, onExit) {
        emitMessage = onMessage;
        emitExit = onExit;
      },
      async send(raw: string) {
        const message = JSON.parse(raw);
        queueMicrotask(() => {
          if (message.id !== undefined && message.method === undefined) {
            // A client→server RESPONSE — the answer to our server→client
            // request below. rust-analyzer stalls without these.
            if (message.id === 999 && message.result === null) {
              serverReq = "answered";
            }
            return;
          }
          if (message.id !== undefined) {
            // Requests answer like the real server: initialize, symbol and
            // folding queries with empty results.
            const result =
              message.method === "initialize"
                ? { capabilities: {}, serverInfo: { name: "fake" } }
                : message.method === "textDocument/documentSymbol" ||
                    message.method === "textDocument/foldingRange"
                  ? []
                  : message.method === "textDocument/hover"
                    ? {
                        contents: {
                          kind: "markdown",
                          value: "**local x: number**\n\nthe answer",
                        },
                      }
                    : null;
            emitMessage(
              JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
            );
            if (message.method === "initialize") {
              // Like a real server: a server→client request right after
              // the handshake; the client must answer it.
              emitMessage(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 999,
                  method: "client/registerCapability",
                  params: { registrations: [] },
                }),
              );
            }
            return;
          }
          if (
            message.method === "textDocument/didOpen" ||
            message.method === "textDocument/didChange"
          ) {
            const uri = message.params.textDocument.uri;
            const text =
              message.method === "textDocument/didOpen"
                ? message.params.textDocument.text
                : message.params.contentChanges[0].text;
            emitMessage(diagnosticsFor(uri, text));
          }
        });
      },
      async stop() {},
    };
  }

  const provider = new LuaAnalyzerProvider(() =>
    LspClient.withTransport(makeTransport()),
  );

  onMount(() => {
    void (async () => {
      await provider.mount([{ path: PATH, text: BROKEN }], [], "C:\\lab");
      await provider.setSource(PATH, BROKEN);
      findings = await provider.diagnostics();
      // The marked slice proves UTF-16 correctness end to end: with byte
      // offsets it would land inside the Cyrillic comment.
      const first = findings[0];
      markedText = first ? BROKEN.slice(first.start, first.end) : "";
      ready = true;
    })();
  });

  async function crash() {
    emitExit();
    serverAlive = false;
    try {
      await provider.setSource(PATH, "x = 1\n");
    } catch (error) {
      afterCrashError = error instanceof Error ? error.message : String(error);
    }
    // Blank the findings so the remount below provably restores them.
    findings = [];
    markedText = "";
  }

  // The recovery path: mount() after a crash must reconnect (a fresh
  // transport) and re-open the workspace cleanly on the same root.
  async function remount() {
    await provider.mount([{ path: PATH, text: BROKEN }], [], "C:\\lab");
    await provider.setSource(PATH, BROKEN);
    findings = await provider.diagnostics();
    const first = findings[0];
    markedText = first ? BROKEN.slice(first.start, first.end) : "";
    serverAlive = true;
  }

  // The hover probe: markdown contents from the wire, split title/body.
  async function probeHover() {
    const card = await provider.hover(PATH, 0);
    hoverTitle = card?.title ?? "";
    hoverBody = card?.body ?? "";
  }
</script>

<div class="flex h-screen flex-col gap-2 p-3 text-sm" data-testid="lsp-lab">
  <div data-testid="lsp-status">
    {ready ? "ready" : "starting"} · server {serverAlive ? "alive" : "exited"}
  </div>
  <button type="button" data-testid="lsp-crash" onclick={() => void crash()}>
    Crash server
  </button>
  <button type="button" data-testid="lsp-remount" onclick={() => void remount()}>
    Remount
  </button>
  <button type="button" data-testid="lsp-hover" onclick={() => void probeHover()}>
    Hover
  </button>
  <div data-testid="lsp-server-req">{serverReq}</div>
  <div data-testid="lsp-hover-title">{hoverTitle}</div>
  <div data-testid="lsp-hover-body">{hoverBody}</div>
  <div data-testid="lsp-marked">marked: «{markedText}»</div>
  <div data-testid="lsp-after-crash">{afterCrashError}</div>
  <ul>
    {#each findings as finding, index (`${finding.start}|${index}`)}
      <li data-testid="lsp-finding">
        {finding.code} @ {finding.start_line}:{finding.start_col} offset {finding.start}
      </li>
    {/each}
  </ul>
</div>
