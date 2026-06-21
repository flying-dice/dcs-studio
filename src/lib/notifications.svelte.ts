// Notification center store (model studio::notifications, issue #56): the one
// place the IDE's transient events are retained. A capped, newest-first list of
// entries with an unread badge count; the Notifications panel and the rail bell
// read from here. Backend-only signals (build, dcs-link, launch) are listened
// for here directly — the same `listen()` pattern as build.svelte.ts:46 — while
// the request/response flow stores (publish, mcp) call `add()` at their own
// success/error points, so each source decides what is notification-worthy.
//
// A separate singleton from `app` (same convention as `build`/`lang`) so the
// panel, the rail badge, and every event source read and write one list. The
// classification and the bounded-history bookkeeping are pure (and unit-tested)
// in notifications-classify.ts; this store is the thin reactive shell over them.

import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BuildDone } from "./api";
import {
  classifyBuildDone,
  dcsConnectedNotification,
  dcsDisconnectedNotification,
  launchDoneNotification,
  appendEntry,
  unreadCountOf,
  markAllReadIn,
  withoutEntry,
  type NotificationEntry,
  type NotificationInput,
} from "./notifications-classify";

export class NotificationStore {
  /** Recorded notifications, newest first (model `Record`). */
  entries = $state<NotificationEntry[]>([]);

  // Monotonic id per entry — the panel keys rows by it and dismiss() targets it.
  private seq = 0;
  // Whether the panel is on screen: arrivals while it is land already-read, so
  // an event the developer is watching never re-raises the badge (the
  // read/unread race called out in Risks).
  private open = false;
  // Backend listeners are attached once, from the root layout.
  private listening = false;

  /**
   * Unseen count for the rail bell badge (model `UnreadCount`). A getter over
   * the `$state` list stays reactive in Svelte 5 — the same pattern as
   * `app.dcsConnected` — and the list is capped, so the recount is cheap.
   */
  get unreadCount(): number {
    return unreadCountOf(this.entries);
  }

  /**
   * Record a classified event (model `Record`): prepend it, drop the oldest
   * past the cap, and mark it read up-front when the panel is already open.
   */
  add(input: NotificationInput): void {
    const entry: NotificationEntry = {
      ...input,
      id: ++this.seq,
      at: Date.now(),
      read: this.open,
    };
    this.entries = appendEntry(this.entries, entry);
  }

  /** Mark every entry read — opening the panel clears the badge. */
  markAllRead(): void {
    this.entries = markAllReadIn(this.entries);
  }

  /** Drop one entry (a row's dismiss button). */
  dismiss(id: number): void {
    this.entries = withoutEntry(this.entries, id);
  }

  /** Empty the list (Clear all). */
  clear(): void {
    this.entries = [];
  }

  /**
   * The panel reports its visibility: opening marks the backlog read so the
   * badge clears, and keeps later arrivals from re-raising it while open.
   */
  setOpen(open: boolean): void {
    this.open = open;
    if (open) this.markAllRead();
  }

  /**
   * Subscribe to the backend-only event channels (build, dcs-link, launch).
   * Called once from the root layout, alongside `app.initDcs()`. A no-op
   * outside Tauri (vite dev / Playwright drive `add()` directly) and idempotent.
   * On a partial attach failure every listener is torn down so a retry starts
   * clean — the same guard as build.svelte.ts's ensureListeners.
   */
  async init(): Promise<void> {
    if (this.listening || !isTauri()) return;
    const attached: UnlistenFn[] = [];
    try {
      attached.push(
        await listen<BuildDone>("build://done", (e) => {
          const note = classifyBuildDone(e.payload);
          if (note) this.add(note);
        }),
      );
      attached.push(
        await listen("dcs://connected", () => this.add(dcsConnectedNotification())),
      );
      attached.push(
        await listen("dcs://disconnected", () => this.add(dcsDisconnectedNotification())),
      );
      attached.push(
        await listen("launch://done", () => this.add(launchDoneNotification())),
      );
      this.listening = true;
    } catch (error) {
      for (const unlisten of attached) unlisten();
      throw error;
    }
  }
}

/** The app-wide instance; the lab builds its own to drive add()/dismiss() from
 * a plain browser. */
export const notifications = new NotificationStore();
