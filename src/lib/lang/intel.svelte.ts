// LanguageIntel — the webview-side language-intelligence layer
// (model/studio/lang.pds): decides which files the engine sees, keeps the
// session in sync with edits, and publishes findings to the Problems panel.
//
// A separate singleton from `app` so the dependency points one way:
// `state.svelte.ts` announces project-opened; components read findings here.

import { readDir, readTextFile } from "$lib/api";
import { allProviders, providerFor } from "./registry";
import type { Diagnostic, ProfileRule, SourceFile } from "./provider";

/** Folders never mounted into the engine. */
const SKIPPED_DIRS = new Set([".git", "node_modules", "target", "build"]);

export type EngineStatus = "off" | "loading" | "ready" | "failed";

class LangIntel {
  /** Workspace-wide findings, sorted by path then offset. */
  diagnostics = $state<Diagnostic[]>([]);
  /** The embedded engine's lifecycle, surfaced in the status bar. */
  engineStatus = $state<EngineStatus>("off");
  // Generation counter: opening another project mid-mount invalidates the
  // older walk, so a slow first mount can never clobber the newer one.
  private mountGeneration = 0;

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
      const files = await this.collectLuaSources(root);
      if (generation !== this.mountGeneration) return; // superseded
      const rules = this.profileRules(root);
      for (const provider of allProviders()) {
        const lower = (path: string) => path.toLowerCase();
        const mine = files.filter((f) =>
          provider.extensions.some((ext) => lower(f.path).endsWith(ext)),
        );
        await provider.mount(mine, rules);
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
   * the editor's lint cycle provides the debounce). Only Lua sources reach
   * the engine.
   */
  async updateSource(path: string, text: string): Promise<void> {
    const provider = providerFor(path);
    if (!provider) return;
    await provider.setSource(path, text);
    await this.refreshProblems();
  }

  /** Drop a deleted file from the session (model `DropSource`). */
  async dropSource(path: string): Promise<void> {
    const provider = providerFor(path);
    if (!provider) return;
    await provider.removeSource(path);
    await this.refreshProblems();
  }

  /** Pull every provider's findings for the Problems panel and markers. */
  private async refreshProblems(): Promise<void> {
    const perProvider = await Promise.all(
      allProviders().map((provider) => provider.diagnostics()),
    );
    this.diagnostics = perProvider.flat();
  }

  /** Every .lua / .d.lua file under the root (model `CollectLuaSources`). */
  private async collectLuaSources(root: string): Promise<SourceFile[]> {
    const files: SourceFile[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await readDir(dir);
      for (const entry of entries) {
        if (entry.is_dir) {
          if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
            await walk(entry.path);
          }
          continue;
        }
        if (providerFor(entry.name)) {
          try {
            const text = await readTextFile(entry.path);
            files.push({ path: entry.path, text });
          } catch {
            // One unreadable file (locked, binary-masquerading, vanished)
            // never takes language intelligence down with it.
          }
        }
      }
    };
    await walk(root);
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
