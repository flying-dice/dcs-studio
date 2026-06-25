// Pure, runes-free notification classification + history logic (model
// studio::notifications, issue #56). The severity model — which transient IDE
// events become info/success/warning/error, and which are actionable — plus
// the bounded-history bookkeeping live here so the vitest gate covers them;
// the runes store (notifications.svelte.ts) and the panel stay thin over this.
//
// A `import type` of BuildDone keeps this module dependency-free at runtime
// (the type is erased), so the node-env unit suite imports it without dragging
// in the Tauri api layer.
import type { BuildDone } from "./api";

/** A notification's urgency; drives the panel's severity dot colour. */
export type Severity = "info" | "success" | "warning" | "error";

/** What emitted the event — shown as a chip on each row. */
export type NotificationSource =
  | "build"
  | "dcs-link"
  | "launch"
  | "publish"
  | "mcp"
  | "lsp"
  | "marketplace";

/**
 * Where a click should land (model `Action`). An entry without one is
 * review-only: the Risks note — an entry that navigates nowhere useful is
 * worse than a plain status line — so only genuinely-actionable events carry
 * one. The store-agnostic intent; the panel maps it to a concrete tool toggle
 * (`open-output` → Output, `focus-publish` → Publish, `open-problems` → the
 * Problems panel where engine health is surfaced).
 */
export type NotificationAction = "open-output" | "focus-publish" | "open-problems";

/** The notification-worthy shape a source hands the store. */
export interface NotificationInput {
  source: NotificationSource;
  severity: Severity;
  message: string;
  action?: NotificationAction;
  /** Secondary context shown dimmed under the message (e.g. server stderr). */
  detail?: string;
  /**
   * When set, repeated arrivals with this key inside the coalesce window fold
   * onto the existing entry (count++) instead of stacking — see
   * {@link recordEntry}. Quietens restart storms (model issue #61 LSP dedupe).
   */
  coalesceKey?: string;
}

/** A recorded notification: an input plus its id, arrival time, and read state. */
export interface NotificationEntry extends NotificationInput {
  id: number;
  /** Epoch ms of arrival — `relativeTime` renders it against the current clock. */
  at: number;
  read: boolean;
  /** How many coalesced arrivals this entry represents (≥1); rendered `×N`. */
  count: number;
}

/**
 * History cap (model `HistoryIsBounded`): the oldest entries fall off the tail
 * so a long session can't grow the list unbounded — the same MAX_LINES-style
 * guard `build.svelte.ts` puts on Output, applied to notifications.
 */
export const MAX_NOTIFICATIONS = 200;

/**
 * How recent a same-`coalesceKey` entry must be to fold a new arrival onto it
 * rather than stack a fresh row (model issue #61 LSP dedupe). A language-server
 * restart storm fires within milliseconds; 10s comfortably brackets it while
 * still letting a genuinely later, separate failure record its own entry.
 */
export const COALESCE_WINDOW_MS = 10_000;

/** Trailing stderr lines kept as an LSP-exit entry's context. */
export const LSP_STDERR_CONTEXT_LINES = 6;

/** A transient error toast lives this long before auto-dismissing. */
export const TOAST_TTL_MS = 5_000;

/** Most error toasts shown at once — the visible stack stays small (NFR). */
export const MAX_TOASTS = 3;

// ── classification (model `Classify*`) ──────────────────────────────────────

/**
 * A finished build (`build://done`). A failure is an actionable error that
 * opens the Output panel at the log; a success is review-only; a no-op
 * (nothing to build — not a Rust project) is not worth a durable entry, so it
 * records nothing.
 */
export function classifyBuildDone(done: BuildDone): NotificationInput | null {
  if (done.no_op) return null;
  if (done.succeeded) {
    return { source: "build", severity: "success", message: "Build succeeded." };
  }
  return {
    source: "build",
    severity: "error",
    message: `Build failed (exit code ${done.exit_code}).`,
    action: "open-output",
  };
}

/** The DCS link came up or recovered — `dcs://connected`. */
export function dcsConnectedNotification(): NotificationInput {
  return { source: "dcs-link", severity: "success", message: "DCS link connected." };
}

/**
 * The DCS link dropped — `dcs://disconnected`. A warning, not an error: a test
 * in flight just lost its sim, and the moment is easy to miss from another
 * panel — exactly the transient signal this center exists to retain.
 */
export function dcsDisconnectedNotification(): NotificationInput {
  return { source: "dcs-link", severity: "warning", message: "DCS link dropped." };
}

/**
 * Whether a `dcs://connected` / `dcs://disconnected` event is a real link
 * transition worth a durable entry, given the last-known state `last`. The
 * backend watch relay (crates/app/src/dcs.rs:59) emits the *current* link state
 * once at startup — not only on changes — so recording every event would raise
 * a spurious entry on a routine launch where nothing was missed (issue #56
 * Risks: "notify only on state transitions"; the status bar already shows the
 * live state). Records only on an actual flip. `last` is `null` until the
 * baseline is seeded from the `dcs_status` snapshot; while unknown the first
 * event establishes it silently rather than raising an entry.
 */
export function shouldRecordLinkEvent(last: boolean | null, connected: boolean): boolean {
  return last !== null && last !== connected;
}

/** A managed DCS launch exited — `launch://done` (payload-less). */
export function launchDoneNotification(): NotificationInput {
  return { source: "launch", severity: "info", message: "DCS exited." };
}

/** A project was shared to GitHub. */
export function publishSharedNotification(repoFullName: string): NotificationInput {
  return { source: "publish", severity: "success", message: `Shared to ${repoFullName}.` };
}

/** A release was published. */
export function publishReleasedNotification(tag: string): NotificationInput {
  return { source: "publish", severity: "success", message: `Published release ${tag}.` };
}

/** A publish or release failed — actionable, focuses the Publish panel. */
export function publishFailedNotification(message: string): NotificationInput {
  return { source: "publish", severity: "error", message, action: "focus-publish" };
}

/**
 * The IDE-hosted MCP server's boot status. Only a fail-closed bind error is
 * notification-worthy — a port clash the developer must resolve; a healthy
 * server is review-only via the status bar, so a running status records
 * nothing.
 */
export function mcpStatusNotification(status: {
  running: boolean;
  error: string | null;
}): NotificationInput | null {
  if (status.running || !status.error) return null;
  return { source: "mcp", severity: "error", message: `MCP server: ${status.error}` };
}

/**
 * A hosted language server exited unexpectedly — `lsp://exit/<id>` (issue #61).
 * An actionable error: the engine is dead until it restarts, so the developer
 * should know without watching logs. The click lands on the Problems panel,
 * where the matching "<engine> crashed" notice lives. Recent stderr (the lines
 * preceding the exit) rides along as context. `coalesceKey` folds a restart
 * storm for the same server into one counted entry rather than a flood.
 *
 * Raised only on a genuine crash, never a deliberate stop (project switch,
 * re-index, shutdown) — the caller gates on the exit being unexpected.
 */
export function classifyLspExit(
  server: { id: string; label: string },
  stderr: readonly string[],
): NotificationInput {
  const detail = stderr.slice(-LSP_STDERR_CONTEXT_LINES).join("\n").trim();
  return {
    source: "lsp",
    severity: "error",
    message: `${server.label} exited unexpectedly.`,
    action: "open-problems",
    coalesceKey: `lsp:${server.id}`,
    ...(detail ? { detail } : {}),
  };
}

/**
 * A Marketplace mod finished installing (issue #61). Review-only info, no
 * action: the product page already shows the outcome and there is nowhere more
 * useful to land — it earns a durable line so a finished install isn't missed,
 * but never a toast (toasts are error-only).
 */
export function marketplaceInstalledNotification(id: string): NotificationInput {
  return { source: "marketplace", severity: "info", message: `Installed ${id}.` };
}

// ── history (model `Record` / `MarkAllRead` / `Dismiss`) ─────────────────────

/** Prepend `entry` (newest-first) and drop the oldest past `cap`. */
export function appendEntry(
  list: NotificationEntry[],
  entry: NotificationEntry,
  cap = MAX_NOTIFICATIONS,
): NotificationEntry[] {
  const next = [entry, ...list];
  return next.length > cap ? next.slice(0, cap) : next;
}

/**
 * Record `entry`, coalescing a restart storm into one counted row (model issue
 * #61 LSP dedupe). When `entry.coalesceKey` matches a still-recent entry (its
 * `at` within `windowMs` of the arrival), that entry is updated in place —
 * count bumped, timestamp/message/detail refreshed to the latest, and re-marked
 * unread if this arrival is unread so the badge re-raises — instead of stacking
 * a new row. Otherwise (no key, or none recent enough) it prepends like
 * {@link appendEntry}. List order is otherwise preserved: a folded entry keeps
 * its place rather than jumping, avoiding churn during a crash loop.
 */
export function recordEntry(
  list: NotificationEntry[],
  entry: NotificationEntry,
  windowMs = COALESCE_WINDOW_MS,
  cap = MAX_NOTIFICATIONS,
): NotificationEntry[] {
  if (entry.coalesceKey !== undefined) {
    const idx = list.findIndex(
      (e) => e.coalesceKey === entry.coalesceKey && entry.at - e.at <= windowMs,
    );
    if (idx !== -1) {
      const prior = list[idx];
      const merged: NotificationEntry = {
        ...prior,
        count: prior.count + 1,
        at: entry.at,
        message: entry.message,
        detail: entry.detail,
        read: prior.read && entry.read,
      };
      const next = [...list];
      next[idx] = merged;
      return next;
    }
  }
  return appendEntry(list, entry, cap);
}

/** How many entries are unread — the rail badge count. */
export function unreadCountOf(list: NotificationEntry[]): number {
  return list.reduce((n, e) => (e.read ? n : n + 1), 0);
}

/**
 * Mark every entry read (opening the panel). Returns a new list, replacing
 * only the entries that change so already-read rows keep their identity.
 */
export function markAllReadIn(list: NotificationEntry[]): NotificationEntry[] {
  return list.map((e) => (e.read ? e : { ...e, read: true }));
}

/** Drop one entry by id (a row's dismiss button). */
export function withoutEntry(list: NotificationEntry[], id: number): NotificationEntry[] {
  return list.filter((e) => e.id !== id);
}

// ── presentation ────────────────────────────────────────────────────────────

/**
 * A compact "2m ago" for `atMs` measured against `nowMs` (both epoch ms). The
 * clock is a parameter so this stays pure and testable — the Welcome panel's
 * `ago`, with the `now` lifted out. A future timestamp never reads negative.
 * Days is the coarsest unit: entries are in-memory and session-scoped (capped
 * at MAX_NOTIFICATIONS, never persisted), so no row survives long enough to
 * reach a month/year branch.
 */
export function relativeTime(nowMs: number, atMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - atMs) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * The entries a transient toast should surface (model issue #61 high-severity
 * toast): error-severity only — info/success/warning record silently in the
 * panel — minus any already dismissed (auto-timeout or click), newest-first,
 * capped at `max` so the visible stack stays small (NFR). The panel remains the
 * durable home; this is the thin selection over it.
 */
export function visibleToasts(
  entries: NotificationEntry[],
  dismissed: ReadonlySet<number>,
  max = MAX_TOASTS,
): NotificationEntry[] {
  return entries
    .filter((e) => e.severity === "error" && !dismissed.has(e.id))
    .slice(0, max);
}
