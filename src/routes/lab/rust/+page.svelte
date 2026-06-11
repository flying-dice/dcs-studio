<script lang="ts">
  // Browser test surface for the rust-analyzer provider path — the exact
  // `RustAnalyzerProvider` class the packaged app uses — over an injected
  // in-page transport (same pattern as /lab/lsp). Covers what only a real
  // rust-analyzer would otherwise reach: rootUri forwarding on initialize,
  // publishDiagnostics conversion for .rs sources, and the no-Cargo.toml
  // root quietly disabling the provider instead of crashing.
  import { onMount } from "svelte";
  import { LspClient, type LspTransport } from "$lib/lang/lsp-client";
  import { RustAnalyzerProvider } from "$lib/lang/rust-analyzer";
  import type { Diagnostic } from "$lib/lang/provider";

  const ROOT = "C:\\lab\\rsproj";
  const PATH = "C:\\lab\\rsproj\\main.rs";
  const SOURCE = 'fn main() {\n    let x: u32 = "oops";\n}\n';

  let findings = $state<Diagnostic[]>([]);
  let markedText = $state("");
  let rootUri = $state("");
  let disabledState = $state("");
  let ready = $state(false);

  // ---- the fake rust-analyzer -----------------------------------------
  let emitMessage: (raw: string) => void = () => {};

  function lineCharOf(text: string, index: number): { line: number; character: number } {
    const before = text.slice(0, index);
    const line = before.split("\n").length - 1;
    const character = index - (before.lastIndexOf("\n") + 1);
    return { line, character };
  }

  function diagnosticsFor(uri: string, text: string): string {
    const at = text.indexOf('"oops"');
    const diagnostics =
      at < 0
        ? []
        : [
            {
              range: {
                start: lineCharOf(text, at),
                end: lineCharOf(text, at + '"oops"'.length),
              },
              severity: 1,
              code: "E0308",
              message: "mismatched types: expected `u32`, found `&str`",
            },
          ];
    return JSON.stringify({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, diagnostics },
    });
  }

  const fakeTransport: LspTransport = {
    async start(onMessage) {
      emitMessage = onMessage;
    },
    async send(raw: string) {
      const message = JSON.parse(raw);
      queueMicrotask(() => {
        if (message.id !== undefined && message.method === undefined) {
          return; // a client response to a server→client request
        }
        if (message.id !== undefined) {
          if (message.method === "initialize") {
            rootUri = message.params?.rootUri ?? "(none)";
          }
          const result =
            message.method === "initialize" ? { capabilities: {} } : null;
          emitMessage(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
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

  const provider = new RustAnalyzerProvider(
    () => LspClient.withTransport(fakeTransport),
    async () => true, // this root has a Cargo.toml
  );

  // A root WITHOUT a Cargo.toml must disable quietly, never connect.
  const noCargoProvider = new RustAnalyzerProvider(
    async () => {
      throw new Error("must not connect without a Cargo.toml");
    },
    async () => false,
  );

  onMount(() => {
    void (async () => {
      await provider.mount([{ path: PATH, text: SOURCE }], [], ROOT);
      await provider.setSource(PATH, SOURCE);
      findings = await provider.diagnostics();
      const first = findings[0];
      markedText = first ? SOURCE.slice(first.start, first.end) : "";

      await noCargoProvider.mount([], [], "C:\\lab\\plain");
      disabledState = noCargoProvider.isDisabled ? "disabled" : "enabled";
      ready = true;
    })();
  });
</script>

<div class="flex h-screen flex-col gap-2 p-3 text-sm" data-testid="rust-lab">
  <div data-testid="rust-status">{ready ? "ready" : "starting"}</div>
  <div data-testid="rust-root">root: {rootUri}</div>
  <div data-testid="rust-disabled">{disabledState}</div>
  <div data-testid="rust-marked">marked: «{markedText}»</div>
  <ul>
    {#each findings as finding, index (`${finding.start}|${index}`)}
      <li data-testid="rust-finding">
        {finding.code} @ {finding.start_line}:{finding.start_col} offset {finding.start}
      </li>
    {/each}
  </ul>
</div>
