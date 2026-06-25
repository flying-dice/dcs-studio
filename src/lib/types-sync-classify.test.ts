import { describe, it, expect } from "vitest";

import { typeSyncIndicator, syncSuccessMessage } from "./types-sync-classify";
import type { DriftStatus, SyncResult, TypeStamp } from "./api";

const stamp = (dcs: string, bridge: string): TypeStamp => ({
  dcs_version: dcs,
  bridge_version: bridge,
});

const drift = (over: Partial<DriftStatus>): DriftStatus => ({
  in_sync: false,
  synced: null,
  running: null,
  ...over,
});

describe("typeSyncIndicator", () => {
  it("a sync in flight reads as syncing, ahead of any verdict", () => {
    // syncing wins even when the verdict still says in-sync from the last run.
    const ind = typeSyncIndicator(drift({ in_sync: true, synced: stamp("2.9", "1.0"), running: stamp("2.9", "1.0") }), true);
    expect(ind.state).toBe("syncing");
    expect(ind.label).toBe("Types: syncing…");
  });

  it("a null verdict (pre-check / not desktop) reads as not synced", () => {
    const ind = typeSyncIndicator(null, false);
    expect(ind.state).toBe("unsynced");
    expect(ind.label).toBe("Types: not synced");
    expect(ind.title).toContain("click to sync");
  });

  it("never synced (synced=null) reads as not synced", () => {
    const ind = typeSyncIndicator(drift({ synced: null }), false);
    expect(ind.state).toBe("unsynced");
  });

  it("matching stamps read as synced and name the running build", () => {
    const ind = typeSyncIndicator(
      drift({ in_sync: true, synced: stamp("2.9.1", "1.4"), running: stamp("2.9.1", "1.4") }),
      false,
    );
    expect(ind.state).toBe("synced");
    expect(ind.label).toBe("Types: synced");
    expect(ind.title).toContain("DCS 2.9.1 · bridge 1.4");
  });

  it("a moved DCS version reads as drift and names the DCS move only", () => {
    const ind = typeSyncIndicator(
      drift({ in_sync: false, synced: stamp("2.9.1", "1.4"), running: stamp("2.9.2", "1.4") }),
      false,
    );
    expect(ind.state).toBe("drift");
    expect(ind.title).toContain("DCS 2.9.1 → 2.9.2");
    expect(ind.title).not.toContain("bridge");
    expect(ind.title).toContain("re-sync");
  });

  it("a moved bridge version reads as drift and names the bridge move only", () => {
    const ind = typeSyncIndicator(
      drift({ in_sync: false, synced: stamp("2.9.1", "1.4"), running: stamp("2.9.1", "1.5") }),
      false,
    );
    expect(ind.state).toBe("drift");
    expect(ind.title).toContain("bridge 1.4 → 1.5");
    expect(ind.title).not.toContain("DCS 2.9.1 →");
  });

  it("both versions moved are both named", () => {
    const ind = typeSyncIndicator(
      drift({ in_sync: false, synced: stamp("2.9.1", "1.4"), running: stamp("2.9.2", "1.5") }),
      false,
    );
    expect(ind.state).toBe("drift");
    expect(ind.title).toContain("DCS 2.9.1 → 2.9.2");
    expect(ind.title).toContain("bridge 1.4 → 1.5");
  });

  it("synced earlier but link down (running unknown) reads as offline, not an alarm", () => {
    const ind = typeSyncIndicator(
      drift({ in_sync: false, synced: stamp("2.9.1", "1.4"), running: null }),
      false,
    );
    expect(ind.state).toBe("offline");
    expect(ind.label).toBe("Types: offline");
    expect(ind.title).toContain("Synced types active");
    expect(ind.title).toContain("Start DCS");
  });
});

describe("syncSuccessMessage", () => {
  it("names the synced build", () => {
    const result: SyncResult = {
      path: "types/generated/dcs.d.lua",
      bytes: 4096,
      stamp: stamp("2.9.1", "1.4"),
    };
    expect(syncSuccessMessage(result)).toBe("Types synced from DCS (DCS 2.9.1 · bridge 1.4).");
  });
});
