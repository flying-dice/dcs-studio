<script lang="ts">
  // Browser test surface for the issue-#31 RE-ATTACH path: the
  // skip-handshake branch (`isNew=false`) the crash/fresh-spawn labs never
  // enter (their fakes always report a fresh spawn, so `if (isNew)` is
  // always taken). Drives the EXACT `LuaAnalyzerProvider` /
  // `RustAnalyzerProvider` + `LspClient` classes over a recording transport
  // that reports `isNew=false`, proving the re-attach contract:
  //   - no `initialize`/`initialized` is sent (re-init = the #31 violation),
  //   - `markInitialized` is NOT called on a re-attach,
  //   - the publishDiagnostics + server-exit handlers are still wired.
  // Both servers are now root-bound (they index from `rootUri`), so a
  // re-attach mount sends nothing on the wire — a later edit opens the file
  // and proves the publish handler is still wired. The fresh (`isNew=true`)
  // mirror asserts the handshake + `markInitialized` fire exactly once.
  import { onMount } from "svelte";
  import { LspClient, type LspTransport } from "$lib/lang/lsp-client";
  import { LuaAnalyzerProvider } from "$lib/lang/lua-analyzer";
  import { RustAnalyzerProvider } from "$lib/lang/rust-analyzer";

  const LUA_PATH = "C:\\lab\\main.lua";
  const LUA_SRC = "function f(\n";
  const RUST_ROOT = "C:\\lab\\rsproj";
  const RUST_PATH = "C:\\lab\\rsproj\\main.rs";
  const RUST_SRC = 'fn main() { let x: u32 = "oops"; }\n';
  // A project-root switch (issue #31 / MR !20): two distinct Cargo roots.
  const RUST_ROOT_A = "C:\\lab\\proj-a";
  const RUST_ROOT_B = "C:\\lab\\proj-b";
  const RUST_A_PATH = "C:\\lab\\proj-a\\main.rs";
  const RUST_B_PATH = "C:\\lab\\proj-b\\main.rs";

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
  let rustSwitchWire = $state("");
  let rustSwitchInitRoot = $state("");
  let rustSwitchFinding = $state("");
  let rustSameRootWire = $state("");

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
    initRootUri: string;
    emitExit: () => void;
  }

  // A transport that records the JSON-RPC methods the client sends and
  // reports a configurable `isNew`; `kind` picks which fake server answers.
  function recordingTransport(
    isNew: boolean,
    kind: "lua" | "rust",
  ): { transport: LspTransport; rec: Recording } {
    const rec: Recording = {
      sent: [],
      markCount: 0,
      initRootUri: "",
      emitExit: () => {},
    };
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
        // Capture the rootUri the client handshakes with, so a root-switch
        // test can prove a fresh spawn re-initializes against the NEW root.
        if (message.method === "initialize")
          rec.initRootUri = message.params?.rootUri ?? "";
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

  // A stateful fake of the backend host (crates/app/src/lsp.rs): it owns at
  // most one live server, bound to the root it was spawned for. connect(root)
  // re-attaches (isNew=false) only when that root matches; any other root
  // "evicts + spawns fresh" (isNew=true) — exactly what reattach_target's root
  // key now decides. `lastRec` exposes the most recent spawn's recorded wire.
  function rootKeyedHost(kind: "lua" | "rust") {
    let boundRoot: string | null = null;
    let live = false;
    let lastRec: Recording = {
      sent: [],
      markCount: 0,
      initRootUri: "",
      emitExit: () => {},
    };
    const connect = async (root: string) => {
      const isNew = !(live && boundRoot === root);
      if (isNew) {
        boundRoot = root;
        live = true;
      }
      const { transport, rec } = recordingTransport(isNew, kind);
      lastRec = rec;
      return LspClient.withTransport(transport);
    };
    return {
      connect,
      get lastRec(): Recording {
        return lastRec;
      },
    };
  }

  onMount(() => {
    void (async () => {
      // dcs-lua, FRESH spawn: lua-analyzer is root-bound (it indexes from
      // rootUri), so a fresh mount handshakes (initialize → initialized) and
      // does NOT didOpen the world — files open lazily on the first edit.
      {
        const { transport, rec } = recordingTransport(true, "lua");
        const provider = new LuaAnalyzerProvider(() =>
          LspClient.withTransport(transport),
        );
        await provider.mount([{ path: LUA_PATH, text: LUA_SRC }], [], "C:\\lab");
        luaFreshWire = rec.sent.join(",");
        luaFreshMark = rec.markCount;
      }

      // dcs-lua, RE-ATTACH: skip the handshake — a root-bound re-attach sends
      // nothing on mount. The publish + exit handlers are still wired: a later
      // edit opens the file and surfaces the finding, and a server death after
      // re-attach surfaces on the next edit.
      {
        const { transport, rec } = recordingTransport(false, "lua");
        const provider = new LuaAnalyzerProvider(() =>
          LspClient.withTransport(transport),
        );
        await provider.mount([{ path: LUA_PATH, text: LUA_SRC }], [], "C:\\lab");
        luaReWire = rec.sent.join(",");
        luaReMark = rec.markCount;
        await provider.setSource(LUA_PATH, LUA_SRC);
        luaReFinding = (await provider.diagnostics())[0]?.code ?? "";
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

      // rust-analyzer, RE-ATTACH AFTER A PROJECT-ROOT SWITCH (issue #31 /
      // MR !20 regression): a webview reload wipes the FE provider
      // (client=null) while the backend rust-analyzer SURVIVES, still rooted at
      // the OLD project. rust-analyzer is root-bound — rootUri is sent once at
      // initialize and it never didOpens — so a root-blind re-attach keeps
      // indexing the dead root forever and Rust diagnostics silently die. The
      // root-keyed host re-attaches only for a matching root; a switch must
      // spawn fresh and re-initialize against the NEW root.
      {
        const host = rootKeyedHost("rust");

        // Before the reload: open project A — fresh spawn, handshake vs A.
        const before = new RustAnalyzerProvider(host.connect, async () => true);
        await before.mount([{ path: RUST_A_PATH, text: RUST_SRC }], [], RUST_ROOT_A);

        // Reload: a NEW provider instance (client=null) while the A-rooted
        // server lives. Open project B (different root): must NOT re-attach to
        // the stale server — fresh spawn + initialize carrying B's rootUri.
        const afterSwitch = new RustAnalyzerProvider(
          host.connect,
          async () => true,
        );
        await afterSwitch.mount(
          [{ path: RUST_B_PATH, text: RUST_SRC }],
          [],
          RUST_ROOT_B,
        );
        rustSwitchWire = host.lastRec.sent.join(",");
        rustSwitchInitRoot = host.lastRec.initRootUri;
        await afterSwitch.setSource(RUST_B_PATH, RUST_SRC);
        rustSwitchFinding = (await afterSwitch.diagnostics())[0]?.code ?? "";

        // Reload again, re-open the SAME project B: the live server is now
        // rooted at B, so this re-attaches with no handshake — the warm path
        // issue #31 preserves, intact for an unchanged root.
        const afterSame = new RustAnalyzerProvider(
          host.connect,
          async () => true,
        );
        await afterSame.mount(
          [{ path: RUST_B_PATH, text: RUST_SRC }],
          [],
          RUST_ROOT_B,
        );
        rustSameRootWire = host.lastRec.sent.join(",");
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
  <div data-testid="reattach-rust-switch-wire">«{rustSwitchWire}»</div>
  <div data-testid="reattach-rust-switch-initroot">{rustSwitchInitRoot}</div>
  <div data-testid="reattach-rust-switch-finding">{rustSwitchFinding}</div>
  <div data-testid="reattach-rust-same-wire">«{rustSameRootWire}»</div>
</div>
