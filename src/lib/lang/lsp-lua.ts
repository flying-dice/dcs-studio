// The packaged-app Lua provider: `dcs-studio-cli lsp` hosted by the
// backend, spoken to over IPC (decisions/005). Implements the same
// LanguageProvider contract as the wasm fallback.
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
  LanguageProvider,
  Location,
  ProfileRule,
  SourceFile,
} from "./provider";

const PUBLISH_TIMEOUT_MS = 3000;

/** Production connection: ask the backend where the CLI lives, host it. */
async function connectViaHost(): Promise<{ client: LspClient; isNew: boolean }> {
  const program = await invoke<string>("lsp_server_path");
  return LspClient.start("dcs-lua", program, ["lsp"]);
}

export class LspLuaProvider implements LanguageProvider {
  readonly id = "dcs-lua";
  readonly extensions = [".lua"];

  private client: LspClient | null = null;
  // Distinguishes "crashed, awaiting remount" (edits must surface the
  // failure) from "never mounted" (edits are quietly ignored).
  private exited = false;
  private readonly texts = new Map<string, string>();
  private readonly versions = new Map<string, number>();
  private readonly findings = new Map<string, Diagnostic[]>();
  private readonly publishWaiters = new Map<string, () => void>();
  private readonly publishListeners: (() => void)[] = [];

  /** `connect` is injectable so `/lab/lsp` drives this exact class. */
  constructor(
    private readonly connect: () => Promise<{
      client: LspClient;
      isNew: boolean;
    }> = connectViaHost,
  ) {}

  // The IDE feeds files itself (it owns the file tree), so the workspace
  // root is irrelevant here — no root walk on the server side.
  async mount(
    files: SourceFile[],
    _rules: ProfileRule[],
    _root: string,
  ): Promise<void> {
    if (!this.client) {
      const { client, isNew } = await this.connect();
      this.client = client;
      this.client.onNotification("textDocument/publishDiagnostics", (params) =>
        this.onPublish(
          params as { uri: string; diagnostics: LspWireDiagnostic[] },
        ),
      );
      this.client.onServerExit(() => {
        // Unstick any lint pass awaiting a publish that will never come.
        for (const [, release] of this.publishWaiters) release();
        this.publishWaiters.clear();
        // Forget the dead session so the next mount() reconnects and
        // didOpens afresh (mount clears texts/findings wholesale).
        this.exited = true;
        this.client = null;
        this.versions.clear();
      });
      // Re-attaching to a server that outlived a webview reload (page
      // refresh / HMR) means it is already initialized — handshaking again
      // is the issue-#31 protocol violation. Only a fresh spawn handshakes.
      if (isNew) {
        await this.client.request("initialize", {
          processId: null,
          rootUri: null,
          capabilities: {},
        });
        await this.client.notify("initialized", {});
        await this.client.markInitialized();
      }
      this.exited = false; // a fresh, live session
    }
    // Wholesale remount: close anything from a previous project.
    for (const path of [...this.texts.keys()]) {
      await this.client.notify("textDocument/didClose", {
        textDocument: { uri: pathToUri(path) },
      });
    }
    this.texts.clear();
    this.versions.clear();
    this.findings.clear();
    for (const file of files) {
      this.texts.set(file.path, file.text);
      this.versions.set(file.path, 1);
      await this.client.notify("textDocument/didOpen", {
        textDocument: {
          uri: pathToUri(file.path),
          languageId: "lua",
          version: 1,
          text: file.text,
        },
      });
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
