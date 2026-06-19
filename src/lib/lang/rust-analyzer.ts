// The rust-analyzer provider: the SECOND hosted language server behind the
// LanguageProvider seam (issue #6 R2, model studio::lang `RustAnalyzer`). The
// connection lifecycle, document sync, and query→DTO conversion live in the
// shared HostedLspProvider base; this class adds only what is rust-specific:
// the Cargo.toml applicability gate, the rich `initialize` capabilities, and
// `$/progress` (indexing / cargo-check feedback for the status-bar chip).
//
// Absence is non-fatal twice over: no Cargo.toml under the root parks the
// provider quietly (`not-applicable`), and a missing rust-analyzer binary
// disables it the same way — an enhancement lost, not an error (model
// `RustProjectGetsDiagnostics`).

import { invoke } from "@tauri-apps/api/core";
import { pathExists } from "$lib/api";
import { LspClient } from "./lsp-client";
import { HostedLspProvider } from "./hosted-lsp-provider";
import type { LanguageProvider } from "./provider";

// A fresh host id per spawn. A project switch stops the old server and starts a
// new one, but the backend host (crates/app/src/lsp.rs) only closes the old
// process's stdin and schedules its kill — the handle lingers in the host map
// until the reader thread reaps the exiting process. A SHARED id would then hit
// lsp_start's idempotent guard (already-present → no-op), so no fresh process
// spawns and the new client talks to a dying one, surfacing as a false "binary
// not found". A unique id never collides with the lingering old server.
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

interface ProgressParams {
  token: string | number;
  value: {
    kind: "begin" | "report" | "end";
    title?: string;
    message?: string;
  };
}

export class RustAnalyzerProvider extends HostedLspProvider {
  readonly id = "rust-analyzer";
  readonly extensions = [".rs"];
  protected readonly languageId = "rust";

  // LSP work-done-progress: token → current task label.
  private readonly activeProgress = new Map<string | number, string>();
  private readonly progressListeners: ((message: string | null) => void)[] = [];

  /** Both seams injectable so `/lab/rust` drives this exact class. */
  constructor(
    connect: () => Promise<LspClient> = connectViaHost,
    private readonly hasCargoToml: (
      root: string,
    ) => Promise<boolean> = cargoTomlExists,
  ) {
    super(connect);
  }

  /** True when the mounted root is not a Cargo project — provider idle. */
  get isDisabled(): boolean {
    return this.disabled;
  }

  protected gate(root: string): Promise<boolean> {
    return this.hasCargoToml(root);
  }

  protected initializeCapabilities(): Record<string, unknown> {
    return {
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
    };
  }

  protected renameUnavailableMessage(): string {
    return "rust-analyzer unavailable";
  }

  protected onClientConnected(client: LspClient): void {
    client.onNotification("$/progress", (params) =>
      this.onProgressReport(params as ProgressParams),
    );
  }

  protected onServerExited(): void {
    this.activeProgress.clear();
    this.emitProgress();
  }

  /** Progress push: `cb` fires with the active task label or null when idle. */
  onProgress(cb: (message: string | null) => void): void {
    this.progressListeners.push(cb);
  }

  private onProgressReport(params: ProgressParams): void {
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
}

export const rustAnalyzerProvider: LanguageProvider = new RustAnalyzerProvider();
