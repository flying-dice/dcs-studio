// LanguageIntel — the webview-side language-intelligence layer
// (model/studio/lang.pds): decides which files the engine sees, keeps the
// session in sync with edits, and publishes findings to the Problems panel.
//
// A separate singleton from `app` so the dependency points one way:
// `state.svelte.ts` announces project-opened; components read findings here.

import { readDir, readTextFile, type DirEntry } from "$lib/api";
import { allProviders, providerFor } from "./registry";
import type {
  Diagnostic,
  DocumentSymbol,
  LanguageProvider,
  ProfileRule,
  ProviderNotice,
  ProviderStatus,
  SourceFile,
} from "./provider";

/** Folders never mounted into the engine. */
const SKIPPED_DIRS = new Set([".git", "node_modules", "target", "build"]);

export type EngineStatus = "off" | "loading" | "ready" | "failed";

/**
 * The filesystem the workspace walk reads through. Injectable so the
 * mount path — the race guard, unreadable-file skip, reset — is testable
 * from the browser e2e suite (`/lab/mount`) without Tauri.
 */
export interface IntelFs {
  readDir(path: string): Promise<DirEntry[]>;
  readTextFile(path: string): Promise<string>;
}

const tauriFs: IntelFs = { readDir, readTextFile };

export class LangIntel {
  /** Both seams injectable so `/lab/mount` and `/lab/rust` drive the
   * real mount path — fake filesystem, fake/failing providers. */
  constructor(
    private readonly fs: IntelFs = tauriFs,
    private readonly providers: () => LanguageProvider[] = allProviders,
  ) {}
  /** Workspace-wide findings, sorted by path then offset. */
  diagnostics = $state<Diagnostic[]>([]);
  /** The hosted engine's lifecycle, surfaced in the status bar. */
  engineStatus = $state<EngineStatus>("off");
  /** Per-provider lifecycle states keyed by provider id. */
  providerStatuses = $state<Record<string, ProviderStatus>>({});
  /** Current background task label per provider, null when idle. */
  providerProgress = $state<Record<string, string | null>>({});
  /** The outlined file's symbols, for the Structure panel (model
   * `RefreshOutline`). */
  symbols = $state<DocumentSymbol[]>([]);
  /** The file `symbols` describes; null while nothing is outlined. */
  outlinePath = $state<string | null>(null);
  /** Last (debounced) editor caret, published by the CodeMirror wiring so
   * the Structure panel's selection can follow the cursor. */
  cursor = $state<{ path: string; offset: number } | null>(null);
  // Stale-outline guard, same shape as mountGeneration: a slow symbols
  // query for a previous file must not clobber the current outline.
  private outlineGeneration = 0;
  // Generation counter: opening another project mid-mount invalidates the
  // older walk, so a slow first mount can never clobber the newer one.
  private mountGeneration = 0;
  // Providers whose push channels are already wired — registration must
  // survive remounts without stacking duplicate callbacks.
  private readonly pushWired = new WeakSet<LanguageProvider>();
  private readonly progressWired = new WeakSet<LanguageProvider>();
  // Editor repaint subscribers: the CodeMirror wiring registers here so a
  // late diagnostics publish forces a re-lint of the open editor (model
  // `LateDiagnosticsPaintWithoutEditing`). One way out — intel never imports
  // the editor layer.
  private readonly repaintListeners = new Set<() => void>();

  // Per-provider install hints shown in the Problems panel notice.
  private static readonly INSTALL_HINTS: Record<string, string> = {
    "rust-analyzer": "rustup component add rust-analyzer",
    "dcs-lua": "build it with `cargo build -p lua-analyzer` (it must sit next to the app executable)",
  };
  private static readonly PROVIDER_LABELS: Record<string, string> = {
    "rust-analyzer": "rust-analyzer",
    "dcs-lua": "Lua language server",
  };

  /**
   * Tooling-availability notices derived from provider statuses. Shown in
   * the Problems panel above file diagnostics when a provider is disabled
   * (binary not found) or has crashed (model `ProviderNoticesInProblems`).
   * Reactive: reads `providerStatuses` so the panel updates instantly.
   */
  get providerNotices(): ProviderNotice[] {
    const notices: ProviderNotice[] = [];
    for (const [id, pStatus] of Object.entries(this.providerStatuses)) {
      const label = LangIntel.PROVIDER_LABELS[id] ?? id;
      if (pStatus === "disabled") {
        notices.push({
          providerId: id,
          severity: "warning",
          message: `${label} not found — diagnostics for this language are unavailable`,
          hint: LangIntel.INSTALL_HINTS[id],
        });
      } else if (pStatus === "failed") {
        notices.push({
          providerId: id,
          severity: "error",
          message: `${label} crashed`,
          hint: "Restart the IDE, or check the developer console for details",
        });
      }
    }
    return notices;
  }

  /** Findings of one file, for the editor's inline markers. */
  fileDiagnostics(path: string): Diagnostic[] {
    return this.diagnostics.filter((d) => d.path === path);
  }

  /**
   * Subscribe to repaint pings: fired when a provider pushes diagnostics
   * after the lint pass already ran, so the editor wiring can force a
   * re-lint and paint the late findings (model `LateDiagnosticsPaintWithoutEditing`).
   * Returns an unsubscribe. Kept as a push channel — not the reactive
   * `diagnostics` store — so the lint pass's own refresh can't feed back
   * into a repaint loop; only a genuine server publish pings.
   */
  onDiagnosticsRepaint(cb: () => void): () => void {
    this.repaintListeners.add(cb);
    return () => this.repaintListeners.delete(cb);
  }

  /**
   * Mount the project into the engine when a workspace opens
   * (model `MountWorkspace`, subscribed to `ProjectOpened`). An engine
   * failure is non-fatal: the IDE works on, the status bar says so.
   */
  async mountWorkspace(root: string): Promise<void> {
    const generation = ++this.mountGeneration;
    this.engineStatus = "loading";
    try {
      const files = await this.collectSources(root);
      if (generation !== this.mountGeneration) return; // superseded
      const rules = this.profileRules(root);
      let anyMounted = false;
      for (const provider of this.providers()) {
        const lower = (path: string) => path.toLowerCase();
        const mine = files.filter((f) =>
          provider.extensions.some((ext) => lower(f.path).endsWith(ext)),
        );
        // Late-push surfacing: slow servers (rust-analyzer's first index)
        // publish findings after the lint pass timed out — re-pull then.
        this.observePush(provider);
        // Background progress feedback: pulses the status-bar chip while
        // the server is indexing or running cargo check (model ProgressFeedback).
        if (provider.onProgress && !this.progressWired.has(provider)) {
          this.progressWired.add(provider);
          provider.onProgress((msg) => {
            this.providerProgress = {
              ...this.providerProgress,
              [provider.id]: msg,
            };
          });
        }
        this.providerStatuses = {
          ...this.providerStatuses,
          [provider.id]: "loading",
        };
        // One engine failing to mount never takes the others down
        // (model `MountRustAnalyzer` is non-fatal; `RefreshProblems`
        // runs unconditionally).
        try {
          await provider.mount(mine, rules, root);
          this.providerStatuses = {
            ...this.providerStatuses,
            [provider.id]: provider.status ?? "ready",
          };
          anyMounted = true;
        } catch (error) {
          this.providerStatuses = {
            ...this.providerStatuses,
            [provider.id]: "failed",
          };
          console.error(
            `language provider '${provider.id}' failed to mount:`,
            error,
          );
        }
      }
      if (generation !== this.mountGeneration) return;
      this.engineStatus = anyMounted ? "ready" : "failed";
      await this.refreshProblems();
    } catch (error) {
      console.error("language engine failed to mount:", error);
      if (generation === this.mountGeneration) this.engineStatus = "failed";
    }
  }

  /** Clear findings and status when the workspace closes. */
  reset(): void {
    this.mountGeneration += 1;
    this.outlineGeneration += 1;
    this.diagnostics = [];
    this.engineStatus = "off";
    this.providerStatuses = {};
    this.providerProgress = {};
    this.symbols = [];
    this.outlinePath = null;
    this.cursor = null;
  }

  /**
   * Outline `path` for the Structure panel (model `RefreshOutline`):
   * called when the active file changes, and re-entered from
   * `updateSource` so the outline follows edits on the same debounced
   * cadence as findings. A file no provider claims (or no file at all)
   * publishes an empty outline — the panel says which case it is. An
   * engine failure surfaces in the status bar (model error arm) and
   * publishes an empty outline.
   */
  async refreshOutline(path: string | null): Promise<void> {
    const generation = ++this.outlineGeneration;
    // On a file change the old file's symbols clear immediately: stale
    // rows must never be clickable against the new file (a click would
    // navigate to the old file's offsets). Same-file refreshes keep the
    // rows for a flicker-free update.
    if (path !== this.outlinePath) this.symbols = [];
    this.outlinePath = path;
    const provider = path ? providerFor(path) : null;
    if (!path || !provider) {
      this.symbols = [];
      return;
    }
    try {
      const symbols = await provider.documentSymbols(path);
      if (generation === this.outlineGeneration) this.symbols = symbols;
    } catch (error) {
      // Engine death surfaces in the status bar, same as updateSource
      // (model `RefreshOutline` error arm); the panel shows an empty
      // outline instead of stale rows.
      console.error("language engine failed:", error);
      // A failure for a superseded query is discarded whole — status bar
      // included — or a dead query for a file the user already left would
      // stick the engine on "failed" while the current file outlines fine.
      if (generation === this.outlineGeneration) {
        this.engineStatus = "failed";
        this.symbols = [];
      }
    }
  }

  /**
   * Keep the engine current as the developer edits (model `UpdateSource`;
   * the editor's lint cycle provides the debounce). Only sources a
   * registered provider claims reach an engine.
   */
  async updateSource(path: string, text: string): Promise<void> {
    const provider = providerFor(path);
    if (!provider) return;
    try {
      await provider.setSource(path, text);
      await this.refreshProblems();
      // The outline follows edits on this same debounced cadence (model
      // `UpdateSource` → `RefreshOutline`).
      if (path === this.outlinePath) await this.refreshOutline(path);
    } catch (error) {
      // Engine death (the hosted server crashing) surfaces in the status
      // bar; the IDE keeps working without intelligence.
      console.error("language engine failed:", error);
      this.engineStatus = "failed";
      if (provider.status) {
        this.providerStatuses = {
          ...this.providerStatuses,
          [provider.id]: provider.status,
        };
      }
    }
  }

  /** Drop a deleted file from the session (model `DropSource`). */
  async dropSource(path: string): Promise<void> {
    const provider = providerFor(path);
    if (!provider) return;
    try {
      await provider.removeSource(path);
      await this.refreshProblems();
    } catch (error) {
      console.error("language engine failed:", error);
      this.engineStatus = "failed";
    }
  }

  /**
   * Wire a provider's late-publish push (idempotent): a hosted server
   * (lua-analyzer, rust-analyzer) publishes findings AFTER the lint pass
   * returned, so the editor squiggles and the Problems panel are stale until a
   * forced re-pull + repaint. Re-read provider status on push so a
   * transitioning server (loading → ready) updates the status chip in real
   * time. The aggregated store is refreshed FIRST, then repaint fires: the
   * forced re-lint reads the store, so it must be fresh first (model
   * `LateDiagnosticsPaintWithoutEditing`). Public so the `/lab/*` surfaces,
   * which mount a provider directly rather than through `mountWorkspace`, can
   * still observe the hosted push.
   */
  observePush(provider: LanguageProvider): void {
    if (!provider.onDiagnostics || this.pushWired.has(provider)) return;
    this.pushWired.add(provider);
    provider.onDiagnostics(() => {
      if (provider.status) {
        this.providerStatuses = {
          ...this.providerStatuses,
          [provider.id]: provider.status,
        };
      }
      void this.refreshProblems().then(() => {
        for (const cb of this.repaintListeners) cb();
      });
    });
  }

  /** Pull every provider's findings for the Problems panel and markers. */
  private async refreshProblems(): Promise<void> {
    const perProvider = await Promise.all(
      this.providers().map((provider) => provider.diagnostics()),
    );
    this.diagnostics = perProvider.flat();
  }

  /** Every provider-claimed file (.lua, .rs, …) under the root (model
   * `CollectSources`). */
  private async collectSources(root: string): Promise<SourceFile[]> {
    const files: SourceFile[] = [];
    // Symlink cycles must not recurse unboundedly: track visited dirs and
    // cap the depth (a real mod tree is a handful of levels).
    const visited = new Set<string>();
    const MAX_DEPTH = 32;
    const walk = async (dir: string, depth: number): Promise<void> => {
      const key = dir.toLowerCase();
      if (depth > MAX_DEPTH || visited.has(key)) return;
      visited.add(key);
      const entries = await this.fs.readDir(dir);
      for (const entry of entries) {
        if (entry.is_dir) {
          if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
            await walk(entry.path, depth + 1);
          }
          continue;
        }
        if (providerFor(entry.name)) {
          try {
            const text = await this.fs.readTextFile(entry.path);
            files.push({ path: entry.path, text });
          } catch {
            // One unreadable file (locked, binary-masquerading, vanished)
            // never takes language intelligence down with it.
          }
        }
      }
    };
    await walk(root, 0);
    return files;
  }

  /**
   * Profile rules from the project's dcs-studio.toml (model
   * `ProfileRules`). Today's manifests declare none, so every file takes
   * the default `mission` profile (SPEC.md §5 of dcs-lua-ls).
   */
  private profileRules(_root: string): ProfileRule[] {
    return [];
  }
}

export const lang = new LangIntel();
