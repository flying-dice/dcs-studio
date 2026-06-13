<script lang="ts">
  // Browser test surface for the issue-#31 RE-ATTACH path: the
  // skip-handshake branch (`isNew=false`) the crash/fresh-spawn labs never
  // enter (their fakes always report a fresh spawn, so `if (isNew)` is
  // always taken). Drives the EXACT `LspLuaProvider` / `RustAnalyzerProvider`
  // + `LspClient` classes over a recording transport that reports
  // `isNew=false`, proving the re-attach contract:
  //   - no `initialize`/`initialized` is sent (re-init = the #31 violation),
  //   - `markInitialized` is NOT called on a re-attach,
  //   - the publishDiagnostics + server-exit handlers are still wired, and
  //   - (dcs-lua) every mounted file is re-`didOpen`ed, while rust-analyzer
  //     re-attaches with no `didOpen` storm.
  // The fresh (`isNew=true`) mirror asserts the handshake + `markInitialized`
  // fire exactly once.
  import { onMount } from "svelte";
  import { LspClient, type LspTransport } from "$lib/lang/lsp-client";
  import { LspLuaProvider } from "$lib/lang/lsp-lua";
  import { RustAnalyzerProvider } from "$lib/lang/rust-analyzer";

  const LUA_PATH = "C:\\lab\\main.lua";
  const LUA_SRC = "function f(\n";
  const RUST_ROOT = "C:\\lab\\rsproj";
  const RUST_PATH = "C:\\lab\\rsproj\\main.rs";
  const RUST_SRC = 'fn main() { let x: u32 = "oops"; }\n';

  let ready = $state(false);
  let luaFreshWire = $state("");
  let luaFreshMark = $state(0);
  let luaReWire = $state("");
  let luaReMark = $state(0);
  let luaReFinding = $state("");
  let luaReExit = $state("");
  let rustReWire = $state("");
  let rustReMark = $state(0);
  let rustReFinding = $state("");

  function lineCharOf(
    text: string,
    index: number,
  ): { line: number; character: number } {
    const before = text.slice(0, index);
    const line = before.split("\n").length - 1;
    const character = index - (before.lastIndexOf("\n") + 1);
    return { line, character };
  }

  function publish(uri: string, needle: string, code: string, text: string): string {
    const at = text.indexOf(needle);
    const diagnostics =
      at < 0
        ? []
        : [
            {
              range: {
                start: lineCharOf(text, at),
                end: lineCharOf(text, at + needle.length),
              },
              severity: 1,
              code,
              message: `${code} sample finding`,
            },
          ];
    return JSON.stringify({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, diagnostics },
    });
  }

  function diagnosticsFor(kind: "lua" | "rust", uri: string, text: string): string {
    return kind === "lua"
      ? publish(uri, "function f(", "LUA-E102", text)
      : publish(uri, '"oops"', "E0308", text);
  }

  interface Recording {
    sent: string[];
    markCount: number;
    emitExit: () => void;
  }

  // A transport that records the JSON-RPC methods the client sends and
  // reports a configurable `isNew`; `kind` picks which fake server answers.
  function recordingTransport(
    isNew: boolean,
    kind: "lua" | "rust",
  ): { transport: LspTransport; rec: Recording } {
    const rec: Recording = { sent: [], markCount: 0, emitExit: () => {} };
    let emitMessage: (raw: string) => void = () => {};
    const transport: LspTransport = {
      async start(onMessage, onExit) {
        emitMessage = onMessage;
        rec.emitExit = onExit;
        return isNew;
      },
      async send(raw: string) {
        const message = JSON.parse(raw);
        if (typeof message.method === "string") rec.sent.push(message.method);
        queueMicrotask(() => {
          // A client→server response (id, no method) needs no reply.
          if (message.id !== undefined && message.method === undefined) return;
          // A request (id + method) is answered like the real server.
          if (message.id !== undefined) {
            const result =
              message.method === "initialize" ? { capabilities: {} } : null;
            emitMessage(
              JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
            );
            return;
          }
          // A didOpen/didChange yields a publish — proving the wired handler.
          if (
            message.method === "textDocument/didOpen" ||
            message.method === "textDocument/didChange"
          ) {
            const uri = message.params.textDocument.uri;
            const text =
              message.method === "textDocument/didOpen"
                ? message.params.textDocument.text
                : message.params.contentChanges[0].text;
            emitMessage(diagnosticsFor(kind, uri, text));
          }
        });
      },
      async stop() {},
      async markInitialized() {
        rec.markCount += 1;
      },
    };
    return { transport, rec };
  }

  onMount(() => {
    void (async () => {
      // dcs-lua, FRESH spawn: handshake once, then open the file.
      {
        const { transport, rec } = recordingTransport(true, "lua");
        const provider = new LspLuaProvider(() =>
          LspClient.withTransport(transport),
        );
        await provider.mount([{ path: LUA_PATH, text: LUA_SRC }], [], "C:\\lab");
        luaFreshWire = rec.sent.join(",");
        luaFreshMark = rec.markCount;
      }

      // dcs-lua, RE-ATTACH: skip the handshake, still open the file and wire
      // the publish + exit handlers.
      {
        const { transport, rec } = recordingTransport(false, "lua");
        const provider = new LspLuaProvider(() =>
          LspClient.withTransport(transport),
        );
        await provider.mount([{ path: LUA_PATH, text: LUA_SRC }], [], "C:\\lab");
        luaReWire = rec.sent.join(",");
        luaReMark = rec.markCount;
        luaReFinding = (await provider.diagnostics())[0]?.code ?? "";
        // Exit handler wired despite the skipped handshake: a server death
        // must surface on the next edit.
        rec.emitExit();
        try {
          await provider.setSource(LUA_PATH, "x = 1\n");
        } catch (error) {
          luaReExit = error instanceof Error ? error.message : String(error);
        }
      }

      // rust-analyzer, RE-ATTACH: skip the handshake; mount must NOT didOpen
      // (it indexes the root itself). A later edit proves the publish handler
      // is still wired on the re-attach path.
      {
        const { transport, rec } = recordingTransport(false, "rust");
        const provider = new RustAnalyzerProvider(
          () => LspClient.withTransport(transport),
          async () => true, // a Cargo project, so mount really connects
        );
        await provider.mount([{ path: RUST_PATH, text: RUST_SRC }], [], RUST_ROOT);
        rustReWire = rec.sent.join(",");
        rustReMark = rec.markCount;
        await provider.setSource(RUST_PATH, RUST_SRC);
        rustReFinding = (await provider.diagnostics())[0]?.code ?? "";
      }

      ready = true;
    })();
  });
</script>

<div class="flex h-screen flex-col gap-2 p-3 text-sm" data-testid="reattach-lab">
  <div data-testid="reattach-status">{ready ? "ready" : "starting"}</div>
  <div data-testid="reattach-lua-fresh-wire">«{luaFreshWire}»</div>
  <div data-testid="reattach-lua-fresh-mark">{luaFreshMark}</div>
  <div data-testid="reattach-lua-re-wire">«{luaReWire}»</div>
  <div data-testid="reattach-lua-re-mark">{luaReMark}</div>
  <div data-testid="reattach-lua-re-finding">{luaReFinding}</div>
  <div data-testid="reattach-lua-re-exit">{luaReExit}</div>
  <div data-testid="reattach-rust-re-wire">«{rustReWire}»</div>
  <div data-testid="reattach-rust-re-mark">{rustReMark}</div>
  <div data-testid="reattach-rust-re-finding">{rustReFinding}</div>
</div>
