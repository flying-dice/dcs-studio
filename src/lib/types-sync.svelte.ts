// Live type-sync store (issue #50, model studio::types TypeSync): the webview
// half of "Sync types from DCS". It triggers the backend sync over the DCS link,
// consumes the post-write reindex signal so a freshly generated `.d.lua` takes
// effect WITHOUT a project reopen (model ReindexWithoutReopen), and holds the
// drift verdict the status-bar indicator reads (model DriftFromRunningVersion).
//
// A separate singleton from `app` (same convention as dcs-link / cargolua) so the
// status bar, the Run menu, and the reindex hook read and write one state. The
// presentation mapping is pure (and unit-tested) in types-sync-classify.ts; this
// store is the thin reactive shell over the sync + drift commands.

import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { syncTypes, typeDrift, type DriftStatus } from "./api";
import { lang } from "./lang/intel.svelte";
import { notifications } from "./notifications.svelte";
import { syncSuccessMessage } from "./types-sync-classify";

class TypeSyncStore {
  /** A sync is in flight — disables the action and pulses the indicator. */
  running = $state(false);
  /** Latest drift verdict for the status-bar indicator; null before the first
   * check and outside the desktop app. */
  drift = $state<DriftStatus | null>(null);

  // The reindex listener attaches once, from the root layout.
  private initialised = false;
  // Stale-verdict guard: a slow drift probe must not clobber a newer one — the
  // status-bar effect re-checks on every link/mission flip. Same shape as
  // LangIntel.mountGeneration.
  private driftGen = 0;

  /**
   * Subscribe to the backend's post-sync reindex signal. Called once from the
   * root layout, alongside app.initDcs(). A no-op outside Tauri (no backend
   * events) and idempotent. The signal (`dcs://types-synced`, payload = the
   * synced root) fires after `sync_types` writes the generated `.d.lua`; we
   * re-index that root so it takes effect without a project reopen, and refresh
   * the drift indicator now the project matches the running build. Any emitter
   * of the signal (the desktop action today) drives both — the IDE never has to
   * reopen the project to see fresh types.
   */
  async init(): Promise<void> {
    if (this.initialised || !isTauri()) return;
    this.initialised = true;
    await listen<string>("dcs://types-synced", (e) => {
      void lang.reindex(e.payload);
      void this.refreshDrift(e.payload);
    });
  }

  /**
   * "Sync types from DCS" (model TypeSync.Sync): pull the running build's types
   * over the live link; the backend writes them under the project and emits the
   * reindex signal init() consumes. Fails closed when the link is down — the
   * backend's start-DCS-first message surfaces as an error notification. No-op
   * while a sync is already running, or outside the desktop app.
   */
  async sync(root: string): Promise<void> {
    if (this.running) return;
    if (!isTauri()) {
      notifications.add({
        source: "dcs-link",
        severity: "info",
        message: "Live type sync requires the desktop app.",
      });
      return;
    }
    this.running = true;
    try {
      const result = await syncTypes(root);
      notifications.add({
        source: "dcs-link",
        severity: "success",
        message: syncSuccessMessage(result),
      });
      // The post-sync event refreshes drift too, but do it here so the indicator
      // flips to in-sync the moment the action returns even if the event lags.
      await this.refreshDrift(root);
    } catch (error) {
      // Fail-closed (link down) or a write/probe error — surface the backend's
      // message verbatim; it carries the start-DCS-first guidance.
      notifications.add({
        source: "dcs-link",
        severity: "error",
        message: String(error),
      });
    } finally {
      this.running = false;
    }
  }

  /**
   * Refresh the drift verdict for the status-bar indicator (model Drift). Driven
   * by the status bar on project open and whenever the DCS link / mission state
   * flips — the running build the verdict compares against moves with both.
   * Generation-guarded so a slow probe never clobbers a newer verdict; a backend
   * failure clears the verdict rather than throwing. A no-op outside Tauri.
   */
  async refreshDrift(root: string): Promise<void> {
    if (!isTauri()) return;
    const gen = ++this.driftGen;
    try {
      const verdict = await typeDrift(root);
      if (gen === this.driftGen) this.drift = verdict;
    } catch {
      if (gen === this.driftGen) this.drift = null;
    }
  }

  /** Clear the drift verdict when the project closes (no root to check). The
   * generation bump discards any probe still in flight. */
  reset(): void {
    this.driftGen += 1;
    this.drift = null;
  }
}

/** Singleton — the one type-sync state the status bar, menu, and reindex hook share. */
export const typeSync = new TypeSyncStore();
