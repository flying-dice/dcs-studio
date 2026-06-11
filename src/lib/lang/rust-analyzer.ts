// The rust-analyzer provider: the SECOND hosted language server behind
// the LanguageProvider seam (issue #6 R2, model studio::lang
// `RustAnalyzer`). Spawned by the same backend host as dcs-lua's LSP
// (decisions/005); unlike dcs-lua-ls, rust-analyzer indexes the project
// itself, so mount hands it a rootUri instead of didOpen-ing the world.
//
// Absence is non-fatal twice over: no Cargo.toml under the root disables
// the provider quietly, and a missing rust-analyzer binary disables it
// the same way — an enhancement lost, not an error; LanguageIntel
// additionally isolates every provider's mount, so even a rejecting
// mount cannot take Lua intelligence down with it (model
// `RustProjectGetsDiagnostics`).

import { invoke } from "@tauri-apps/api/core";
import { pathExists } from "$lib/api";
import { LspClient } from "./lsp-client";
import { lineStarts } from "./offsets";
import {
  convertDiagnostic,
  convertHover,
  convertSymbol,
  convertSymbolInformation,
  lineEnd,
  lineStart,
  offsetToPosition,
  pathToUri,
  uriToPath,
  type LspWireDiagnostic,
  type LspWireHover,
  type LspWireSymbol,
  type LspWireSymbolInformation,
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
  ProviderStatus,
  SourceFile,
} from "./provider";

const PUBLISH_TIMEOUT_MS = 3000;

// A fresh host id per spawn. A project switch stops the old server and
// starts a new one, but the backend host (crates/app/src/lsp.rs) only
// closes the old process's stdin and schedules its kill — the handle
// lingers in the host map until the reader thread reaps the exiting
// process. A SHARED id would then hit lsp_start's idempotent guard
// (already-present → no-op), so no fresh process spawns and the new client
// talks to a dying one, surfacing as a false "binary not found". A unique
// id never collides with the lingering old server.
let hostConnectionSeq = 0;

/** Production connection: ask the backend for the binary, host it. */
async function connectViaHost(): Promise<LspClient> {
  const program = await invoke<string>("rust_analyzer_path");
  hostConnectionSeq += 1;
  // `:`-separated, NOT `#`: the id becomes a Tauri event name
  // (`lsp://message/<id>`) and Tauri rejects `#`, making listen() throw.
  return LspClient.start(`rust-analyzer:${hostConnectionSeq}`, program, []);
}

/** Production Cargo.toml probe through the backend fs commands. */
function cargoTomlExists(root: string): Promise<boolean> {
  return pathExists(`${root.replace(/[\\/]+$/, "")}/Cargo.toml`);
}

export class RustAnalyzerProvider implements LanguageProvider {
  readonly id = "rust-analyzer";
  readonly extensions = [".rs"];

  private client: LspClient | null = null;
  private mountedRoot: string | null = null;
  private disabled = true;
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
  // LSP work-done-progress: token → current task label.
  private readonly activeProgress = new Map<string | number, string>();
  private readonly progressListeners: ((message: string | null) => void)[] = [];

  /** Both seams injectable so `/lab/rust` drives this exact class. */
  constructor(
    private readonly connect: () => Promise<LspClient> = connectViaHost,
    private readonly hasCargoToml: (
      root: string,
    ) => Promise<boolean> = cargoTomlExists,
  ) {}

  /** True when the mounted root is not a Cargo project — provider idle. */
  get isDisabled(): boolean {
    return this.disabled;
  }

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

    let isCargoProject = false;
    try {
      isCargoProject = await this.hasCargoToml(root);
    } catch {
      // No backend to ask (plain browser) — same outcome as no project.
    }
    if (!isCargoProject) {
      this.disabled = true;
      this._status = "not-applicable";
      return; // non-fatal: the IDE keeps every other provider
    }
    this.disabled = false;

    if (!this.client) {
      this._status = "loading";
      // Phase 1 — resolve and spawn the binary. The ONLY failure here is the
      // binary genuinely missing (rust_analyzer_path errs) or unspawnable, so
      // this is the one path that reports "binary not found" with install
      // guidance. A handshake failure below must never reach this label.
      let client: LspClient;
      try {
        client = await this.connect();
      } catch (error) {
        this.disabled = true;
        this._status = "disabled";
        this.client = null;
        console.warn("rust-analyzer unavailable:", error);
        return; // non-fatal: the IDE keeps every other provider
      }
      // Phase 2 — the binary is present; complete the LSP handshake. A failure
      // here is a crash or a wedged server (e.g. a reconnect racing the old
      // server's shutdown), NOT an absent binary — so it reports "failed",
      // never telling the developer to install what is already installed.
      this.client = client;
      try {
        client.onNotification("textDocument/publishDiagnostics", (params) =>
          this.onPublish(
            params as { uri: string; diagnostics: LspWireDiagnostic[] },
          ),
        );
        client.onNotification("$/progress", (params) =>
          this.onProgressReport(
            params as {
              token: string | number;
              value: { kind: "begin" | "report" | "end"; title?: string; message?: string };
            },
          ),
        );
        client.onServerExit(() => {
          for (const [, release] of this.publishWaiters) release();
          this.publishWaiters.clear();
          this.activeProgress.clear();
          this.emitProgress();
          // Forget the dead session so the next mount() — same root or
          // not — reconnects and re-opens cleanly instead of talking to
          // a server that no longer exists.
          this.exited = true;
          this._status = "failed";
          this.client = null;
          this.versions.clear();
          this.mountedRoot = null;
        });
        await client.request("initialize", {
          processId: null,
          // rust-analyzer walks the project itself from here.
          rootUri: pathToUri(root),
          capabilities: {
            textDocument: {
              publishDiagnostics: {
                // Related information gives context like "trait defined here".
                relatedInformation: true,
                // Tag support enables unused-code hints and deprecated markers.
                tagSupport: { valueSet: [1, 2] },
              },
              hover: { contentFormat: ["markdown", "plaintext"] },
            },
            workspace: {
              // Declaring configuration support lets rust-analyzer send
              // workspace/configuration requests, which activates checkOnSave
              // (cargo check in the background for dependency-level errors).
              configuration: true,
              workspaceFolders: true,
              didChangeConfiguration: { dynamicRegistration: true },
            },
            window: {
              // Declaring workDoneProgress lets rust-analyzer send $/progress
              // notifications so we can surface indexing/check feedback.
              workDoneProgress: true,
            },
          },
        });
        await client.notify("initialized", {});
        this.exited = false; // a fresh, live session
        this._status = "ready";
      } catch (error) {
        // Handshake failed though the binary is present — a crash or wedged
        // server, not absence. Report "failed", not "binary not found".
        this.disabled = true;
        this._status = "failed";
        this.client = null;
        console.warn("rust-analyzer handshake failed:", error);
      }
    }
  }

  async setSource(path: string, text: string): Promise<void> {
    if (this.disabled) return;
    if (!this.client) {
      // A crashed session must surface the failure (the status bar says
      // "failed"); a never-mounted one quietly ignores edits.
      if (this.exited) throw new Error("language server exited");
      return;
    }
    if (!this.client.isAlive) throw new Error("language server exited");
    // An unchanged re-lint — forced when a late publish repaints squiggles
    // (codemirror.ts repaintDiagnostics) — must not churn the server with a
    // no-op didChange: it would bump the version, restart the publish wait,
    // and re-enter onPublish, looping the repaint. Skip only once the file
    // is already open in the session; the first didOpen always goes through.
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
          languageId: "rust",
          version: 1,
          text,
        },
      });
    }
    // First-index latency means this often times out; the onDiagnostics
    // push channel surfaces whatever lands later.
    await published;
  }

  async removeSource(path: string): Promise<void> {
    if (this.client && !this.disabled && this.versions.has(path)) {
      await this.client.notify("textDocument/didClose", {
        textDocument: { uri: pathToUri(path) },
      });
    }
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

  /** Progress push: `cb` fires with the active task label or null when idle. */
  onProgress(cb: (message: string | null) => void): void {
    this.progressListeners.push(cb);
  }

  private onProgressReport(params: {
    token: string | number;
    value: { kind: "begin" | "report" | "end"; title?: string; message?: string };
  }): void {
    const { token, value } = params;
    if (value.kind === "begin") {
      this.activeProgress.set(token, value.title ?? "");
    } else if (value.kind === "report" && value.message) {
      this.activeProgress.set(token, value.message);
    } else if (value.kind === "end") {
      this.activeProgress.delete(token);
    }
    this.emitProgress();
  }

  private emitProgress(): void {
    const messages = [...this.activeProgress.values()];
    const current = messages.length > 0 ? messages[messages.length - 1] : null;
    for (const cb of this.progressListeners) cb(current);
  }

  async documentSymbols(path: string): Promise<DocumentSymbol[]> {
    if (!this.client || this.disabled) return [];
    const text = this.texts.get(path) ?? "";
    const response = (await this.client.request("textDocument/documentSymbol", {
      textDocument: { uri: pathToUri(path) },
    })) as (LspWireSymbol | LspWireSymbolInformation)[] | null;
    const symbols = response ?? [];
    if (symbols.length === 0) return [];
    // rust-analyzer may answer with flat SymbolInformation[] instead of
    // DocumentSymbol[] — `location` on the first element tells them apart.
    if ("location" in symbols[0]) {
      return (symbols as LspWireSymbolInformation[]).map((symbol) =>
        convertSymbolInformation(symbol, text),
      );
    }
    return (symbols as LspWireSymbol[]).map((symbol) =>
      convertSymbol(symbol, text),
    );
  }

  async foldingRanges(path: string): Promise<FoldingRange[]> {
    if (!this.client || this.disabled) return [];
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

  // Phase 2 parity with dcs-lua comes later.
  async complete(_path: string, _offset: number): Promise<CompletionItem[]> {
    return [];
  }

  async hover(path: string, offset: number): Promise<Hover | null> {
    if (!this.client || this.disabled) return null;
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

export const rustAnalyzerProvider: LanguageProvider =
  new RustAnalyzerProvider();
