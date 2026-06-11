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
  LanguageProvider,
  ProfileRule,
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
  constructor(private readonly fs: IntelFs = tauriFs) {}
  /** Workspace-wide findings, sorted by path then offset. */
  diagnostics = $state<Diagnostic[]>([]);
  /** The embedded engine's lifecycle, surfaced in the status bar. */
  engineStatus = $state<EngineStatus>("off");
  // Generation counter: opening another project mid-mount invalidates the
  // older walk, so a slow first mount can never clobber the newer one.
  private mountGeneration = 0;
  // Providers whose push channel is already wired — registration must
  // survive remounts without stacking duplicate callbacks.
  private readonly pushWired = new WeakSet<LanguageProvider>();

  /** Findings of one file, for the editor's inline markers. */
  fileDiagnostics(path: string): Diagnostic[] {
    return this.diagnostics.filter((d) => d.path === path);
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
      for (const provider of allProviders()) {
        const lower = (path: string) => path.toLowerCase();
        const mine = files.filter((f) =>
          provider.extensions.some((ext) => lower(f.path).endsWith(ext)),
        );
        // Late-push surfacing: slow servers (rust-analyzer's first index)
        // publish findings after the lint pass timed out — re-pull then.
        if (provider.onDiagnostics && !this.pushWired.has(provider)) {
          this.pushWired.add(provider);
          provider.onDiagnostics(() => void this.refreshProblems());
        }
        await provider.mount(mine, rules, root);
      }
      if (generation !== this.mountGeneration) return;
      this.engineStatus = "ready";
      await this.refreshProblems();
    } catch (error) {
      console.error("language engine failed to mount:", error);
      if (generation === this.mountGeneration) this.engineStatus = "failed";
    }
  }

  /** Clear findings and status when the workspace closes. */
  reset(): void {
    this.mountGeneration += 1;
    this.diagnostics = [];
    this.engineStatus = "off";
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
    } catch (error) {
      // Engine death (server crash, wasm trap) surfaces in the status
      // bar; the IDE keeps working without intelligence.
      console.error("language engine failed:", error);
      this.engineStatus = "failed";
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

  /** Pull every provider's findings for the Problems panel and markers. */
  private async refreshProblems(): Promise<void> {
    const perProvider = await Promise.all(
      allProviders().map((provider) => provider.diagnostics()),
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
