// HostedLspProvider — the shared base for the two backend-hosted language
// servers behind the LanguageProvider seam (issue #6 R2, decisions/005):
// dcs-lua's `lua-analyzer` and `rust-analyzer`. Both are spawned by the same
// backend host (crates/app/src/lsp.rs), index the project themselves from a
// `rootUri`, and speak the same LSP subset — so the connection lifecycle,
// document sync, the publish-diagnostics push, and every query→DTO conversion
// are identical. Subclasses supply ONLY the per-engine differences: the
// `connect` seam, the `initialize` capabilities, the rename-refused message,
// applicability (`gate`), and optional extras (rust: `$/progress`; lua: inlay
// hints). LanguageIntel isolates every provider's mount, so a rejecting mount
// can never take another engine down (model `EngineFailureIsNonFatal`).

import { LspClient } from "./lsp-client";
import { lineStarts } from "./offsets";
import {
  convertDiagnostic,
  convertHover,
  convertLocation,
  convertSymbol,
  convertSymbolInformation,
  convertWorkspaceEdit,
  lineEnd,
  lineStart,
  offsetToPosition,
  pathToUri,
  uriToPath,
  type LspWireDiagnostic,
  type LspWireHover,
  type LspWireLocation,
  type LspWireLocationLink,
  type LspWireSymbol,
  type LspWireSymbolInformation,
  type LspWireWorkspaceEdit,
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
  WorkspaceEdit,
} from "./provider";

const PUBLISH_TIMEOUT_MS = 3000;

export abstract class HostedLspProvider implements LanguageProvider {
  abstract readonly id: string;
  abstract readonly extensions: string[];
  /** The LSP `languageId` sent on `didOpen` (e.g. `"rust"`, `"lua"`). */
  protected abstract readonly languageId: string;

  protected client: LspClient | null = null;
  protected mountedRoot: string | null = null;
  // Distinguishes "crashed, awaiting remount" (edits must surface the failure)
  // from "never mounted" (edits are quietly ignored).
  protected exited = false;
  // rust-analyzer gates on a Cargo.toml and parks itself when there's none;
  // lua is always applicable, so this stays false there and the `disabled`
  // guards below reduce to plain `!client` checks — same behaviour as before.
  protected disabled = false;
  protected _status: ProviderStatus = "off";

  get status(): ProviderStatus {
    return this._status;
  }

  protected readonly texts = new Map<string, string>();
  protected readonly versions = new Map<string, number>();
  protected readonly findings = new Map<string, Diagnostic[]>();
  protected readonly publishWaiters = new Map<string, () => void>();
  protected readonly publishListeners: (() => void)[] = [];
  // Crash subscribers (issue #61): notified when the hosted server exits
  // unexpectedly, never on a deliberate stop.
  private readonly crashListeners: ((info: {
    id: string;
    stderr: string[];
  }) => void)[] = [];

  protected constructor(protected readonly connect: () => Promise<LspClient>) {}

  // ---- per-engine hooks ----------------------------------------------------

  /** The `initialize` request's `capabilities` for this engine. */
  protected abstract initializeCapabilities(): Record<string, unknown>;

  /** The message a refused rename rejects with. */
  protected abstract renameUnavailableMessage(): string;

  /** Whether the provider has work in `root`. Default: always applicable (lua);
   * rust overrides with a Cargo.toml probe — `false` parks it idle. */
  protected gate(_root: string): Promise<boolean> {
    return Promise.resolve(true);
  }

  /** Register engine-specific notifications after connect (rust: `$/progress`).
   * Default: none. */
  protected onClientConnected(_client: LspClient): void {}

  /** Engine-specific teardown when the server exits (rust: clear progress).
   * Default: none. */
  protected onServerExited(): void {}

  // ---- lifecycle -----------------------------------------------------------

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

    let applicable = false;
    try {
      applicable = await this.gate(root);
    } catch {
      // No backend to ask (plain browser) — same outcome as no project.
    }
    if (!applicable) {
      this.disabled = true;
      this._status = "not-applicable";
      return; // non-fatal: the IDE keeps every other provider
    }
    this.disabled = false;

    if (!this.client) {
      this._status = "loading";
      // Phase 1 — resolve and spawn the binary. The ONLY failure here is the
      // binary genuinely missing or unspawnable, so this reports "disabled"
      // with a build/install hint (non-fatal), NOT a crash. A handshake failure
      // below must never reach this label.
      let client: LspClient;
      try {
        client = await this.connect();
      } catch (error) {
        this.disabled = true;
        this._status = "disabled";
        this.client = null;
        console.warn(`${this.id} unavailable:`, error);
        return; // non-fatal: the IDE keeps every other provider
      }
      // Phase 2 — the binary is present; complete the LSP handshake. A failure
      // here is a crash or wedged server (e.g. a reconnect racing the old
      // server's shutdown), NOT an absent binary — so it reports "failed",
      // never telling the developer to install what is already installed.
      this.client = client;
      try {
        client.onNotification("textDocument/publishDiagnostics", (params) =>
          this.onPublish(
            params as { uri: string; diagnostics: LspWireDiagnostic[] },
          ),
        );
        this.onClientConnected(client);
        client.onServerExit((info) => {
          // Unstick any lint pass awaiting a publish that will never come.
          for (const [, release] of this.publishWaiters) release();
          this.publishWaiters.clear();
          this.onServerExited();
          // Forget the dead session so the next mount() — same root or not —
          // reconnects and re-opens cleanly instead of talking to a server
          // that no longer exists.
          this.exited = true;
          this._status = "failed";
          this.client = null;
          this.versions.clear();
          this.mountedRoot = null;
          // A genuine crash (not a deliberate stop) earns a notification, with
          // the server's recent stderr as context (issue #61).
          if (info.unexpected) {
            for (const cb of this.crashListeners) {
              cb({ id: this.id, stderr: info.stderr });
            }
          }
        });
        await client.request("initialize", {
          processId: null,
          // The server walks the project itself from here.
          rootUri: pathToUri(root),
          capabilities: this.initializeCapabilities(),
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
        console.warn(`${this.id} handshake failed:`, error);
      }
    }
  }

  /**
   * Drop the live server so the next {@link mount} reconnects and re-initializes,
   * re-walking the project (issue #51: re-index after a dependency fetch adds
   * modules the server only discovers at initialize). The same teardown the
   * project-switch path uses, plus clearing `mountedRoot` so a remount on the
   * SAME root is no longer short-circuited. Idempotent — a no-op when not
   * connected.
   */
  async restart(): Promise<void> {
    if (this.client) {
      await this.client.stop();
      this.client = null;
    }
    // Force the next mount() to reconnect even for the same project.
    this.mountedRoot = null;
    this.exited = false;
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
    // and re-enter onPublish, looping the repaint. Skip only once the file is
    // already open in the session; the first didOpen always goes through.
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
          languageId: this.languageId,
          version: 1,
          text,
        },
      });
    }
    // First-index latency means this often times out; the onDiagnostics push
    // channel surfaces whatever lands later.
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

  /** Crash push (issue #61): `cb` runs when the hosted server exits
   * unexpectedly, with this provider's id and the server's trailing stderr. */
  onServerCrash(cb: (info: { id: string; stderr: string[] }) => void): void {
    this.crashListeners.push(cb);
  }

  async documentSymbols(path: string): Promise<DocumentSymbol[]> {
    if (!this.client || this.disabled) return [];
    const text = this.texts.get(path) ?? "";
    const response = (await this.client.request("textDocument/documentSymbol", {
      textDocument: { uri: pathToUri(path) },
    })) as (LspWireSymbol | LspWireSymbolInformation)[] | null;
    const symbols = response ?? [];
    if (symbols.length === 0) return [];
    // Some servers (rust-analyzer) answer with flat SymbolInformation[] instead
    // of DocumentSymbol[] — `location` on the first element tells them apart.
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

  // Phase 2 parity comes later; neither server advertises completion yet.
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

  async definition(path: string, offset: number): Promise<Location | null> {
    if (!this.client || this.disabled) return null;
    const response = (await this.client.request("textDocument/definition", {
      textDocument: { uri: pathToUri(path) },
      position: offsetToPosition(lineStarts(this.textOf(path)), offset),
    })) as LspWireLocation | LspWireLocationLink | LspWireLocation[] | null;
    const first = Array.isArray(response) ? response[0] : response;
    return first ? convertLocation(first, (p) => this.textOf(p)) : null;
  }

  async references(path: string, offset: number): Promise<Location[]> {
    if (!this.client || this.disabled) return [];
    const response = (await this.client.request("textDocument/references", {
      textDocument: { uri: pathToUri(path) },
      position: offsetToPosition(lineStarts(this.textOf(path)), offset),
      context: { includeDeclaration: true },
    })) as LspWireLocation[] | null;
    return (response ?? []).map((loc) =>
      convertLocation(loc, (p) => this.textOf(p)),
    );
  }

  async rename(
    path: string,
    offset: number,
    newName: string,
  ): Promise<WorkspaceEdit> {
    if (!this.client || this.disabled) {
      throw new Error(this.renameUnavailableMessage());
    }
    const response = (await this.client.request("textDocument/rename", {
      textDocument: { uri: pathToUri(path) },
      position: offsetToPosition(lineStarts(this.textOf(path)), offset),
      newName,
    })) as LspWireWorkspaceEdit | null;
    return convertWorkspaceEdit(response, (p) => this.textOf(p));
  }

  /** The remembered text of a mounted file (empty if not mounted). */
  protected textOf(path: string): string {
    return this.texts.get(path) ?? "";
  }

  // ---- diagnostics push ----------------------------------------------------

  protected onPublish(params: {
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
  protected nextPublish(path: string): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, PUBLISH_TIMEOUT_MS);
      this.publishWaiters.set(path, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
