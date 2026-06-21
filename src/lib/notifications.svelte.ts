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
import { dcsStatus, type BuildDone } from "./api";
import {
  classifyBuildDone,
  dcsConnectedNotification,
  dcsDisconnectedNotification,
  shouldRecordLinkEvent,
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
  // Last-known DCS link state, seeded from the backend snapshot before the
  // listeners attach (see init). A link event raises an entry only when it
  // flips this — the relay re-emits the current state at boot, which is not a
  // transition. `null` until seeded: the first event then sets it silently.
  private linkConnected: boolean | null = null;

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
    // Seed the last-known link state before attaching listeners. The relay
    // re-emits the current link state at startup (dcs.rs:59); seeding first
    // means that boot emit predates this listener (dropped, not recorded), and
    // every event we do observe is matched against the baseline — so only a
    // real flip raises an entry, never a routine launch.
    await this.seedLinkState();
    const attached: UnlistenFn[] = [];
    try {
      attached.push(
        await listen<BuildDone>("build://done", (e) => {
          const note = classifyBuildDone(e.payload);
          if (note) this.add(note);
        }),
      );
      attached.push(
        await listen("dcs://connected", () => this.onLinkEvent(true)),
      );
      attached.push(
        await listen("dcs://disconnected", () => this.onLinkEvent(false)),
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

  /**
   * Record a link up/down only on a real flip from the last-known state. The
   * relay's boot emit carries the current state, not a change, and the status
   * bar already shows it — see `shouldRecordLinkEvent`.
   */
  private onLinkEvent(connected: boolean): void {
    const record = shouldRecordLinkEvent(this.linkConnected, connected);
    this.linkConnected = connected;
    if (record) {
      this.add(connected ? dcsConnectedNotification() : dcsDisconnectedNotification());
    }
  }

  /**
   * Best-effort baseline from the backend snapshot — the same `dcs_status`
   * source `dcs-link.svelte.ts` seeds from. On failure the baseline stays
   * unknown and the first link event establishes it without an entry.
   */
  private async seedLinkState(): Promise<void> {
    try {
      const { connected } = await dcsStatus();
      this.linkConnected = connected;
    } catch {
      /* no snapshot — first link event sets the baseline, no spurious entry */
    }
  }
}

/** The app-wide instance; the lab builds its own to drive add()/dismiss() from
 * a plain browser. */
export const notifications = new NotificationStore();
