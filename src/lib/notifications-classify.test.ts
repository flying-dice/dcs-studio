import { describe, it, expect } from "vitest";

import {
  classifyBuildDone,
  dcsConnectedNotification,
  dcsDisconnectedNotification,
  launchDoneNotification,
  publishSharedNotification,
  publishReleasedNotification,
  publishFailedNotification,
  mcpStatusNotification,
  appendEntry,
  unreadCountOf,
  markAllReadIn,
  withoutEntry,
  relativeTime,
  MAX_NOTIFICATIONS,
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

  it("never reads negative for a future timestamp", () => {
    expect(relativeTime(now, now + 5_000)).toBe("just now");
  });
});
