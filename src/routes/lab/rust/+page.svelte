<script lang="ts">
  // Browser test surface for the rust-analyzer provider path — the exact
  // `RustAnalyzerProvider` class the packaged app uses — over an injected
  // in-page transport (same pattern as /lab/lsp). Covers what only a real
  // rust-analyzer would otherwise reach: rootUri forwarding on initialize,
  // publishDiagnostics conversion for .rs sources, and the no-Cargo.toml
  // root quietly disabling the provider instead of crashing.
  import { onMount } from "svelte";
  import type { DirEntry } from "$lib/api";
  import { LspClient, type LspTransport } from "$lib/lang/lsp-client";
  import { LangIntel, type IntelFs } from "$lib/lang/intel.svelte";
  import { RustAnalyzerProvider } from "$lib/lang/rust-analyzer";
  import type { Diagnostic, LanguageProvider } from "$lib/lang/provider";

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
      return true; // the in-page fake is always a fresh spawn
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

  // ---- intel-level scenario: a missing binary never fails the layer ----
  // A real LangIntel over a fake fs and an injected provider list: a tiny
  // always-finding Lua provider next to a REAL RustAnalyzerProvider whose
  // connect rejects like a missing binary. Mounting must end "ready" with
  // the Lua finding intact — rust-analyzer is an enhancement lost.
  const intelFile = (path: string): DirEntry => ({
    name: path.split("/").pop() ?? path,
    path,
    is_dir: false,
  });

  const intelFs: IntelFs = {
    async readDir(): Promise<DirEntry[]> {
      return [intelFile("/X/x.lua"), intelFile("/X/x.rs")];
    },
    async readTextFile(path: string): Promise<string> {
      return path.endsWith(".lua") ? "if x then\n" : "fn main() {}\n";
    },
  };

  const LUA_FINDING: Diagnostic = {
    path: "/X/x.lua",
    severity: "error",
    code: "LUA-E102",
    code_description: "",
    message: "unterminated 'if' block: 'end' expected",
    start: 0,
    end: 2,
    start_line: 1,
    start_col: 1,
    end_line: 1,
    end_col: 3,
  };

  const fakeLuaProvider: LanguageProvider = {
    id: "fake-lua",
    extensions: [".lua"],
    async mount() {},
    async setSource() {},
    async removeSource() {},
    async diagnostics() {
      return [LUA_FINDING];
    },
    async documentSymbols() {
      return [];
    },
    async foldingRanges() {
      return [];
    },
    async complete() {
      return [];
    },
    async hover() {
      return null;
    },
    async definition() {
      return null;
    },
  };

  const missingBinaryProvider = new RustAnalyzerProvider(
    () =>
      Promise.reject(
        new Error(
          "rust-analyzer not found — rustup component add rust-analyzer",
        ),
      ),
    async () => true, // a Cargo project, so mount really tries to connect
  );

  const intel = new LangIntel(intelFs, () => [
    fakeLuaProvider,
    missingBinaryProvider,
  ]);

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

  <button
    type="button"
    data-testid="intel-mount"
    onclick={() => void intel.mountWorkspace("/X")}
  >
    Mount intel workspace
  </button>
  <div data-testid="intel-status">{intel.engineStatus}</div>
  <ul>
    {#each intel.diagnostics as finding, index (`${finding.path}|${finding.start}|${index}`)}
      <li data-testid="intel-finding">{finding.path} {finding.code}</li>
    {/each}
  </ul>
</div>
