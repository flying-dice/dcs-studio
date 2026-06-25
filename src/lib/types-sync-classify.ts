// Pure, runes-free presentation logic for the live type-sync status indicator
// (issue #50, model studio::types). The status-bar chip and its tooltip are
// derived from a DriftStatus here so the mapping — which verdict reads as in
// sync, drift, offline, or never-synced, and how a drift names the version that
// moved — is covered by the vitest gate; the runes store (types-sync.svelte.ts)
// and the footer chip stay thin over this. Mirrors notifications-classify.ts.
//
// An `import type` of the DTOs keeps this module dependency-free at runtime (the
// types are erased), so the node-env unit suite imports it without dragging in
// the Tauri api layer.
import type { DriftStatus, SyncResult, TypeStamp } from "./api";

/**
 * The type-sync indicator's state, in order of urgency:
 * - `syncing`  — a sync is in flight.
 * - `drift`    — the project's synced types no longer match the RUNNING build
 *                (both versions known and differing) — actionable: re-sync.
 * - `synced`   — synced types match the running build.
 * - `offline`  — synced earlier but the link is down, so the running build is
 *                unknown; the last sync still resolves hover, so it is not an
 *                alarm (model OfflineFallbackToLastSync).
 * - `unsynced` — nothing has ever been synced from DCS for this project (also
 *                the pre-check / outside-the-desktop-app state).
 */
export type TypeSyncState = "syncing" | "drift" | "synced" | "offline" | "unsynced";

/** A status-bar indicator: its state, the chip label, and the tooltip. The
 * component owns the dot palette; this owns the words. */
export interface TypeSyncIndicator {
  state: TypeSyncState;
  label: string;
  title: string;
}

/** A "DCS x · bridge y" identity for one stamp, for tooltips. */
function describeStamp(stamp: TypeStamp): string {
  return `DCS ${stamp.dcs_version} · bridge ${stamp.bridge_version}`;
}

/**
 * Name which half of the build moved between the synced stamp and the running
 * one — DCS itself, the bridge DLL, or both — so a drift tooltip is specific
 * (model DriftStatus: surface both stamps "so the UI can name exactly which
 * version moved"). Falls back to a generic phrase if the verdict says drift yet
 * neither field differs (defensive — the model never produces that).
 */
function describeDrift(synced: TypeStamp, running: TypeStamp): string {
  const parts: string[] = [];
  if (synced.dcs_version !== running.dcs_version) {
    parts.push(`DCS ${synced.dcs_version} → ${running.dcs_version}`);
  }
  if (synced.bridge_version !== running.bridge_version) {
    parts.push(`bridge ${synced.bridge_version} → ${running.bridge_version}`);
  }
  return parts.length ? parts.join(", ") : "the running build changed";
}

/**
 * Map the drift verdict (and whether a sync is currently running) to the
 * status-bar indicator. `drift` is null before the first check and outside the
 * desktop app — treated as not-yet-synced.
 */
export function typeSyncIndicator(
  drift: DriftStatus | null,
  syncing: boolean,
): TypeSyncIndicator {
  if (syncing) {
    return {
      state: "syncing",
      label: "Types: syncing…",
      title: "Syncing types from the running DCS build…",
    };
  }
  if (!drift || drift.synced === null) {
    return {
      state: "unsynced",
      label: "Types: not synced",
      title: "No types synced from DCS yet — click to sync from the running build.",
    };
  }
  const synced = drift.synced;
  const running = drift.running;
  if (drift.in_sync && running) {
    return {
      state: "synced",
      label: "Types: synced",
      title: `Types match the running build (${describeStamp(running)}).`,
    };
  }
  if (running) {
    // Both stamps known and they differ — genuine drift, actionable.
    return {
      state: "drift",
      label: "Types: drift",
      title: `Types are out of date: ${describeDrift(synced, running)} — click to re-sync.`,
    };
  }
  // Synced before, but the running build is unknown (link down): the last sync
  // still resolves hover offline; not an alarm (model OfflineFallbackToLastSync).
  return {
    state: "offline",
    label: "Types: offline",
    title: `Synced types active (${describeStamp(synced)}). Start DCS to check for drift.`,
  };
}

/** Success line for the notification center after a sync (names the build). */
export function syncSuccessMessage(result: SyncResult): string {
  return `Types synced from DCS (${describeStamp(result.stamp)}).`;
}
