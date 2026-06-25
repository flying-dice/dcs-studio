import { describe, it, expect } from "vitest";

import {
  classifyBuildDone,
  dcsConnectedNotification,
  dcsDisconnectedNotification,
  shouldRecordLinkEvent,
  launchDoneNotification,
  publishSharedNotification,
  publishReleasedNotification,
  publishFailedNotification,
  mcpStatusNotification,
  classifyLspExit,
  marketplaceInstalledNotification,
  appendEntry,
  recordEntry,
  unreadCountOf,
  markAllReadIn,
  withoutEntry,
  relativeTime,
  visibleToasts,
  pruneDismissed,
  MAX_NOTIFICATIONS,
  COALESCE_WINDOW_MS,
  type NotificationEntry,
} from "./notifications-classify";

function entry(id: number, over: Partial<NotificationEntry> = {}): NotificationEntry {
  return {
    id,
    at: id,
    read: false,
    source: "build",
    severity: "info",
    message: `n${id}`,
    count: 1,
    ...over,
  };
}

describe("classifyBuildDone", () => {
  it("a failed build is an actionable error that opens Output", () => {
    expect(classifyBuildDone({ succeeded: false, exit_code: 101, no_op: false })).toEqual({
      source: "build",
      severity: "error",
      message: "Build failed (exit code 101).",
      action: "open-output",
    });
  });

  it("a successful build is a review-only success", () => {
    expect(classifyBuildDone({ succeeded: true, exit_code: 0, no_op: false })).toEqual({
      source: "build",
      severity: "success",
      message: "Build succeeded.",
    });
  });

  it("a no-op build records nothing (not worth a durable entry)", () => {
    expect(classifyBuildDone({ succeeded: true, exit_code: 0, no_op: true })).toBeNull();
  });
});

describe("link / launch classifiers", () => {
  it("connect is a success, drop is a warning", () => {
    expect(dcsConnectedNotification()).toEqual({
      source: "dcs-link",
      severity: "success",
      message: "DCS link connected.",
    });
    expect(dcsDisconnectedNotification()).toEqual({
      source: "dcs-link",
      severity: "warning",
      message: "DCS link dropped.",
    });
  });

  it("a managed launch exit is informational", () => {
    expect(launchDoneNotification()).toEqual({
      source: "launch",
      severity: "info",
      message: "DCS exited.",
    });
  });
});

describe("shouldRecordLinkEvent", () => {
  it("records a real flip from the seeded baseline", () => {
    expect(shouldRecordLinkEvent(true, false)).toBe(true); // a live link drops
    expect(shouldRecordLinkEvent(false, true)).toBe(true); // a dropped link recovers
  });

  it("suppresses the boot re-emit of the current state (no flip)", () => {
    expect(shouldRecordLinkEvent(true, true)).toBe(false);
    expect(shouldRecordLinkEvent(false, false)).toBe(false);
  });

  it("stays silent on the first event when no snapshot seeded the baseline", () => {
    expect(shouldRecordLinkEvent(null, true)).toBe(false);
    expect(shouldRecordLinkEvent(null, false)).toBe(false);
  });
});

describe("publish classifiers", () => {
  it("share and release are successes that name the target", () => {
    expect(publishSharedNotification("octo/mod").message).toBe("Shared to octo/mod.");
    expect(publishReleasedNotification("v1.2.0").message).toBe("Published release v1.2.0.");
  });

  it("a failure is an actionable error that focuses the Publish panel", () => {
    expect(publishFailedNotification("token expired")).toEqual({
      source: "publish",
      severity: "error",
      message: "token expired",
      action: "focus-publish",
    });
  });
});

describe("mcpStatusNotification", () => {
  it("notifies only on a fail-closed bind error", () => {
    expect(mcpStatusNotification({ running: false, error: "port 25570 in use" })).toEqual({
      source: "mcp",
      severity: "error",
      message: "MCP server: port 25570 in use",
    });
  });

  it("a running server records nothing", () => {
    expect(mcpStatusNotification({ running: true, error: null })).toBeNull();
  });

  it("not-yet-bound without an error records nothing", () => {
    expect(mcpStatusNotification({ running: false, error: null })).toBeNull();
  });
});

describe("appendEntry", () => {
  it("prepends newest-first", () => {
    const list = appendEntry([entry(1)], entry(2));
    expect(list.map((e) => e.id)).toEqual([2, 1]);
  });

  it("drops the oldest past the cap, keeping the newest", () => {
    let list: NotificationEntry[] = [];
    for (let i = 1; i <= MAX_NOTIFICATIONS + 5; i++) list = appendEntry(list, entry(i));
    expect(list).toHaveLength(MAX_NOTIFICATIONS);
    expect(list[0]?.id).toBe(MAX_NOTIFICATIONS + 5);
    expect(list[list.length - 1]?.id).toBe(6); // ids 1..5 fell off the tail
  });

  it("honours a custom cap", () => {
    const capped = appendEntry([entry(3), entry(2), entry(1)], entry(4), 3);
    expect(capped.map((e) => e.id)).toEqual([4, 3, 2]);
  });
});

describe("unreadCountOf / markAllReadIn", () => {
  it("counts only the unread", () => {
    expect(unreadCountOf([entry(1, { read: true }), entry(2), entry(3)])).toBe(2);
  });

  it("markAllRead clears the count and keeps already-read rows by reference", () => {
    const alreadyRead = entry(1, { read: true });
    const marked = markAllReadIn([alreadyRead, entry(2)]);
    expect(unreadCountOf(marked)).toBe(0);
    expect(marked[0]).toBe(alreadyRead);
    expect(marked[1]?.read).toBe(true);
  });
});

describe("withoutEntry", () => {
  it("drops the matching id and keeps the rest", () => {
    expect(withoutEntry([entry(1), entry(2), entry(3)], 2).map((e) => e.id)).toEqual([1, 3]);
  });

  it("is a no-op for an unknown id", () => {
    expect(withoutEntry([entry(1)], 99).map((e) => e.id)).toEqual([1]);
  });
});

describe("relativeTime", () => {
  const now = 1_000_000_000_000;

  it("collapses the first few seconds to 'just now'", () => {
    expect(relativeTime(now, now)).toBe("just now");
    expect(relativeTime(now, now - 3_000)).toBe("just now");
  });

  it("formats seconds, minutes, hours, and days", () => {
    expect(relativeTime(now, now - 30_000)).toBe("30s ago");
    expect(relativeTime(now, now - 2 * 60_000)).toBe("2m ago");
    expect(relativeTime(now, now - 3 * 3_600_000)).toBe("3h ago");
    expect(relativeTime(now, now - 2 * 86_400_000)).toBe("2d ago");
  });

  it("caps at days — entries are session-scoped, so no month/year branch", () => {
    expect(relativeTime(now, now - 45 * 86_400_000)).toBe("45d ago");
    expect(relativeTime(now, now - 800 * 86_400_000)).toBe("800d ago");
  });

  it("never reads negative for a future timestamp", () => {
    expect(relativeTime(now, now + 5_000)).toBe("just now");
  });
});

describe("classifyLspExit", () => {
  it("is an actionable error opening engine status, keyed per server, with stderr context", () => {
    expect(
      classifyLspExit({ id: "dcs-lua", label: "Lua language server" }, [
        "warming up",
        "thread 'main' panicked",
        "note: backtrace",
      ]),
    ).toEqual({
      source: "lsp",
      severity: "error",
      message: "Lua language server exited unexpectedly.",
      action: "open-problems",
      coalesceKey: "lsp:dcs-lua",
      detail: "warming up\nthread 'main' panicked\nnote: backtrace",
    });
  });

  it("keeps only the trailing stderr lines as context", () => {
    const stderr = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const note = classifyLspExit({ id: "rust-analyzer", label: "rust-analyzer" }, stderr);
    expect(note.detail).toBe("line 15\nline 16\nline 17\nline 18\nline 19\nline 20");
  });

  it("omits detail when there is no stderr", () => {
    const note = classifyLspExit({ id: "dcs-lua", label: "Lua language server" }, []);
    expect(note.detail).toBeUndefined();
    expect(note).toMatchObject({ source: "lsp", severity: "error", action: "open-problems" });
  });
});

describe("marketplaceInstalledNotification", () => {
  it("is a review-only info that names the mod (no action, so it never toasts)", () => {
    expect(marketplaceInstalledNotification("octo/hornet-mod")).toEqual({
      source: "marketplace",
      severity: "info",
      message: "Installed octo/hornet-mod.",
    });
  });
});

describe("recordEntry (coalescing)", () => {
  const lspEntry = (id: number, at: number, over: Partial<NotificationEntry> = {}) =>
    entry(id, {
      at,
      source: "lsp",
      severity: "error",
      coalesceKey: "lsp:dcs-lua",
      message: "Lua language server exited unexpectedly.",
      ...over,
    });

  it("prepends a keyless entry, same as appendEntry", () => {
    expect(recordEntry([entry(1)], entry(2)).map((e) => e.id)).toEqual([2, 1]);
  });

  it("folds a same-key arrival within the window onto the existing row, bumping count", () => {
    const first = lspEntry(1, 1000, { detail: "panic A" });
    const merged = recordEntry([first], lspEntry(2, 5000, { detail: "panic B" }));
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: 1, // the original row, updated in place — not a new entry
      count: 2,
      at: 5000, // refreshed to the latest arrival
      detail: "panic B", // latest context wins
    });
  });

  it("re-raises a folded entry as unread when the new arrival is unread", () => {
    const merged = recordEntry(
      [lspEntry(1, 1000, { read: true })],
      lspEntry(2, 2000, { read: false }),
    );
    expect(merged[0]?.read).toBe(false);
  });

  it("stacks a fresh entry once the coalesce window has passed", () => {
    const list = recordEntry(
      [lspEntry(1, 1000)],
      lspEntry(2, 1000 + COALESCE_WINDOW_MS + 1),
    );
    expect(list.map((e) => e.id)).toEqual([2, 1]);
    expect(list.every((e) => e.count === 1)).toBe(true);
  });

  it("never folds across different server keys", () => {
    const list = recordEntry(
      [lspEntry(1, 1000)],
      lspEntry(2, 1500, { coalesceKey: "lsp:rust-analyzer" }),
    );
    expect(list.map((e) => e.id)).toEqual([2, 1]);
  });
});

describe("visibleToasts", () => {
  const list = [
    entry(5, { severity: "error" }),
    entry(4, { severity: "info" }),
    entry(3, { severity: "error" }),
    entry(2, { severity: "warning" }),
    entry(1, { severity: "error" }),
  ];

  it("selects only error-severity entries, newest-first", () => {
    expect(visibleToasts(list, new Set()).map((e) => e.id)).toEqual([5, 3, 1]);
  });

  it("excludes dismissed ids", () => {
    expect(visibleToasts(list, new Set([5])).map((e) => e.id)).toEqual([3, 1]);
  });

  it("caps the visible stack", () => {
    const errors = [6, 5, 4, 3].map((id) => entry(id, { severity: "error" }));
    expect(visibleToasts(errors, new Set(), 2).map((e) => e.id)).toEqual([6, 5]);
  });
});

describe("pruneDismissed", () => {
  const list = [entry(3), entry(2), entry(1)];

  it("drops dismissed ids the store has evicted", () => {
    // 9 and 8 are gone from the store; 2 still present
    const pruned = pruneDismissed(new Set([9, 8, 2]), list);
    expect([...pruned].sort()).toEqual([2]);
  });

  it("keeps every dismissed id still backed by an entry", () => {
    const dismissed = new Set([3, 1]);
    expect([...pruneDismissed(dismissed, list)].sort()).toEqual([1, 3]);
  });

  it("returns the same set reference when nothing is stale (no needless write)", () => {
    const dismissed = new Set([2]);
    expect(pruneDismissed(dismissed, list)).toBe(dismissed);
  });

  it("prunes to empty when the store has been cleared", () => {
    expect(pruneDismissed(new Set([3, 2, 1]), []).size).toBe(0);
  });
});
