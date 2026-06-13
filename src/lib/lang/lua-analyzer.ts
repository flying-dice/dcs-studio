// The packaged-app Lua provider: the standalone `lua-analyzer` binary
// hosted by the backend, spoken to over IPC (decisions/005) — hosted exactly
// like rust-analyzer (it indexes the project from the rootUri). Implements
// the same LanguageProvider contract as the wasm fallback.
//
// Wire shapes and position conversion live in lsp-wire.ts, shared with
// the rust-analyzer provider.

import { invoke } from "@tauri-apps/api/core";
import { LspClient } from "./lsp-client";
import { lineStarts } from "./offsets";
import {
  convertDiagnostic,
  convertHover,
  convertSymbol,
  lineEnd,
  lineStart,
  offsetToPosition,
  pathToUri,
  uriToPath,
  type LspWireDiagnostic,
  type LspWireHover,
  type LspWireSymbol,
} from "./lsp-wire";
import type {
  CompletionItem,
  Diagnostic,
  DocumentSymbol,
  FoldingRange,
  Hover,
  InlayHint,
  LanguageProvider,
  Location,
  ProfileRule,
  ProviderStatus,
  SourceFile,
} from "./provider";

const PUBLISH_TIMEOUT_MS = 3000;

/** Production connection: ask the backend for the lua-analyzer binary, host
 * it as a standalone process — exactly how rust-analyzer is hosted. */
async function connectViaHost(root: string): Promise<{
  client: LspClient;
  isNew: boolean;
}> {
  const program = await invoke<string>("lua_analyzer_path");
  // lua-analyzer is root-bound (it indexes the project from `rootUri`): pass
  // `root` as the re-attach key so the backend re-attaches only to a server
  // rooted here — a different root evicts the stale server and spawns fresh,
  // re-initializing against the new project (issue #31 / MR !20).
  return LspClient.start("dcs-lua", program, [], root);
}

export class LuaAnalyzerProvider implements LanguageProvider {
  // The LOGICAL provider id is shared with the wasm engine (dcs-lua.ts): the
  // app sees one "dcs-lua" Lua provider whichever transport backs it. The
  // BINARY is lua-analyzer; the backend assigns a physical id per spawn and
  // re-attaches by this logical id keyed on the project root.
  readonly id = "dcs-lua";
  readonly extensions = [".lua"];

  private client: LspClient | null = null;
  private mountedRoot: string | null = null;
  // Distinguishes "crashed, awaiting remount" (edits must surface the
  // failure) from "never mounted" (edits are quietly ignored).
  private exited = false;
  private _status: ProviderStatus = "off";

  get status(): ProviderStatus {
    return this._status;
  }
  private readonly texts = new Map<string, string>();
  private readonly versions = new Map<string, number>();
  private readonly findings = new Map<string, Diagnostic[]>();
  private readonly publishWaiters = new Map<string, () => void>();
  private readonly publishListeners: (() => void)[] = [];

  /** `connect` is injectable so `/lab/lsp` drives this exact class. */
  constructor(
    private readonly connect: (root: string) => Promise<{
      client: LspClient;
      isNew: boolean;
    }> = connectViaHost,
  ) {}

  // lua-analyzer indexes the project itself from the rootUri (like
  // rust-analyzer) — mount hands it the root and lets its initialize walk
  // find every Lua source, instead of didOpen-ing the world.
  async mount(
    files: SourceFile[],
    _rules: ProfileRule[],
    root: string,
  ): Promise<void> {
    // Project switch: a server initialized on the old rootUri cannot be
    // re-rooted — stop it and reconnect against the new project.
    if (this.client && this.mountedRoot !== root) {
      await this.client.stop();
      this.client = null;
    }
    this.mountedRoot = root;
    this.texts.clear();
    this.versions.clear();
    this.findings.clear();
    // Sources are remembered (not opened) so late publishes for files the
    // server found on disk still convert positions against real text.
    for (const file of files) this.texts.set(file.path, file.text);

    if (!this.client) {
      this._status = "loading";
      // Phase 1 — resolve and spawn the binary. The only failure here is the
      // binary genuinely missing (lua_analyzer_path errs) or unspawnable.
      // Report it as "disabled" with a build hint (non-fatal, like
      // rust-analyzer), NOT an opaque "crashed": Lua intelligence is gone but
      // the IDE stays usable (model `EngineFailureIsNonFatal`).
      let client: LspClient;
      let isNew: boolean;
      try {
        ({ client, isNew } = await this.connect(root));
      } catch (error) {
        this._status = "disabled";
        this.client = null;
        console.warn("lua-analyzer unavailable:", error);
        return;
      }
      // Phase 2 — the binary is present; complete the handshake. A failure
      // here is a crash or wedged server, NOT an absent binary — "failed".
      this.client = client;
      try {
        client.onNotification("textDocument/publishDiagnostics", (params) =>
          this.onPublish(
            params as { uri: string; diagnostics: LspWireDiagnostic[] },
          ),
        );
        client.onServerExit(() => {
          // Unstick any lint pass awaiting a publish that will never come.
          for (const [, release] of this.publishWaiters) release();
          this.publishWaiters.clear();
          // Forget the dead session so the next mount() reconnects afresh.
          this.exited = true;
          this._status = "failed";
          this.client = null;
          this.versions.clear();
          this.mountedRoot = null;
        });
        // A re-attach (isNew=false) happens only for the SAME root: the
        // backend keys re-attach on the project root, so a re-attached server
        // is already indexing THIS root — skip the handshake (re-initializing
        // a live server is the #31 violation). A different root evicts the
        // stale server and spawns fresh (isNew=true), re-initializing here.
        if (isNew) {
          await client.request("initialize", {
            processId: null,
            // lua-analyzer walks the project itself from here.
            rootUri: pathToUri(root),
            capabilities: {},
          });
          await client.notify("initialized", {});
          await client.markInitialized();
        }
        this.exited = false; // a fresh, live session
        this._status = "ready";
      } catch (error) {
        this._status = "failed";
        this.client = null;
        console.warn("lua-analyzer handshake failed:", error);
      }
    }
  }

  async setSource(path: string, text: string): Promise<void> {
    if (!this.client) {
      // A crashed session must surface the failure (the status bar says
      // "failed"); a never-mounted one quietly ignores edits.
      if (this.exited) throw new Error("language server exited");
      return;
    }
    if (!this.client.isAlive) throw new Error("language server exited");
    // Skip a no-op re-lint (an unchanged buffer re-linted because a late
    // publish forced a repaint): re-sending didChange with identical text
    // only churns the server and restarts the publish wait. mount remembers
    // the source but does not open it, so the first setSource always didOpens.
    if (this.versions.has(path) && this.texts.get(path) === text) return;
    this.texts.set(path, text);
    const published = this.nextPublish(path);
    if (this.versions.has(path)) {
      const version = (this.versions.get(path) ?? 1) + 1;
      this.versions.set(path, version);
      await this.client.notify("textDocument/didChange", {
        textDocument: { uri: pathToUri(path), version },
        contentChanges: [{ text }],
      });
    } else {
      this.versions.set(path, 1);
      await this.client.notify("textDocument/didOpen", {
        textDocument: {
          uri: pathToUri(path),
          languageId: "lua",
          version: 1,
          text,
        },
      });
    }
    await published; // findings current (or timed out) when we resolve
  }

  async removeSource(path: string): Promise<void> {
    if (!this.client) return;
    await this.client.notify("textDocument/didClose", {
      textDocument: { uri: pathToUri(path) },
    });
    this.texts.delete(path);
    this.versions.delete(path);
    this.findings.delete(path);
  }

  async diagnostics(): Promise<Diagnostic[]> {
    return [...this.findings.values()]
      .flat()
      .sort((a, b) => a.path.localeCompare(b.path) || a.start - b.start);
  }

  /** Late-push surfacing: `cb` runs on every publishDiagnostics. */
  onDiagnostics(cb: () => void): void {
    this.publishListeners.push(cb);
  }

  async documentSymbols(path: string): Promise<DocumentSymbol[]> {
    if (!this.client) return [];
    const text = this.texts.get(path) ?? "";
    const response = (await this.client.request("textDocument/documentSymbol", {
      textDocument: { uri: pathToUri(path) },
    })) as LspWireSymbol[] | null;
    return (response ?? []).map((symbol) => convertSymbol(symbol, text));
  }

  async foldingRanges(path: string): Promise<FoldingRange[]> {
    if (!this.client) return [];
    const text = this.texts.get(path) ?? "";
    const starts = lineStarts(text);
    const response = (await this.client.request("textDocument/foldingRange", {
      textDocument: { uri: pathToUri(path) },
    })) as { startLine: number; endLine: number }[] | null;
    return (response ?? []).map((range) => ({
      start: lineStart(starts, range.startLine),
      end: lineEnd(text, starts, range.endLine),
    }));
  }

  // Phase 2 ports — the server doesn't advertise these capabilities yet.
  async complete(_path: string, _offset: number): Promise<CompletionItem[]> {
    return [];
  }

  async hover(path: string, offset: number): Promise<Hover | null> {
    if (!this.client) return null;
    const text = this.texts.get(path) ?? "";
    const response = (await this.client.request("textDocument/hover", {
      textDocument: { uri: pathToUri(path) },
      position: offsetToPosition(lineStarts(text), offset),
    })) as LspWireHover | null;
    return convertHover(response);
  }

  async definition(_path: string, _offset: number): Promise<Location | null> {
    return null;
  }

  // lua-analyzer advertises `inlayHintProvider` and answers from the same
  // engine inlay-hint query as the wasm path. Defensive `[]` on any error so
  // a server that lacks it can never abort the editor's lint pass.
  async inlayHints(path: string): Promise<InlayHint[]> {
    if (!this.client) return [];
    const text = this.texts.get(path) ?? "";
    const starts = lineStarts(text);
    const lastLine = Math.max(0, starts.length - 1);
    let response:
      | { position: { line: number; character: number }; label: unknown }[]
      | null;
    try {
      response = (await this.client.request("textDocument/inlayHint", {
        textDocument: { uri: pathToUri(path) },
        range: {
          start: { line: 0, character: 0 },
          end: { line: lastLine, character: 0 },
        },
      })) as
        | { position: { line: number; character: number }; label: unknown }[]
        | null;
    } catch {
      return []; // server lacks inlay hints — surface none, never throw
    }
    return (response ?? []).map((hint) => ({
      offset: lineStart(starts, hint.position.line) + hint.position.character,
      label: typeof hint.label === "string" ? hint.label : String(hint.label),
      kind: "Type",
    }));
  }

  // ---- diagnostics push ----------------------------------------------------

  private onPublish(params: {
    uri: string;
    diagnostics: LspWireDiagnostic[];
  }): void {
    const path = uriToPath(params.uri);
    const text = this.texts.get(path) ?? "";
    const starts = lineStarts(text);
    this.findings.set(
      path,
      params.diagnostics.map((d) => convertDiagnostic(d, path, starts)),
    );
    this.publishWaiters.get(path)?.();
    this.publishWaiters.delete(path);
    for (const listener of this.publishListeners) listener();
  }

  /** Resolves on the next publish for `path`, or after a grace timeout. */
  private nextPublish(path: string): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, PUBLISH_TIMEOUT_MS);
      this.publishWaiters.set(path, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
