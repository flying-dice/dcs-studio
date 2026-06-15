// Integrated terminal state (model/studio/term.pds, issue #13): the `Terminal`
// container's orchestration — launch profiles, the tab strip, and the
// spawn/close lifecycle. A separate singleton from `app` (same convention as
// `build` and `lang`).
//
// Tabs live HERE, not in the component, so a session survives the panel
// collapse that unmounts the view (model PanelCollapseKeepsSessionAlive): the
// child and pty keep running Rust-side, the component re-renders the strip from
// this store on remount, and each xterm replays its buffer. The exit listener
// also lives here so a session that ends while collapsed still drops its tab.

import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { app } from "./state.svelte";
import {
  termSpawn,
  termKill,
  termList,
  termDefaultShell,
  type TermSpawnSpec,
  type TermExit,
} from "./api";

/** A launch profile (model `Profile`). */
export interface TermProfile {
  id: string;
  label: string;
  command: string;
  args: string[];
  /** Agentic harness (Claude Code, OpenCode): the spawn pre-registers the MCP server. */
  harness: boolean;
}

/** One tab in the strip. `error` is set when the spawn failed — a labelled
 *  dead tab the developer can read and close, never a silent vanish. */
export interface TermTab {
  id: string;
  profileId: string;
  label: string;
  error: string | null;
}

/** localStorage key for user-defined profiles (model: "arbitrary user-defined
 *  profiles supported"). Built-ins are not persisted. */
const USER_PROFILES_KEY = "dcs.terminalProfiles";

/** Built-in agentic-harness profiles; the detected shell is prepended at init. */
const BUILTIN_HARNESSES: TermProfile[] = [
  { id: "claude-code", label: "Claude Code", command: "claude", args: [], harness: true },
  { id: "opencode", label: "OpenCode", command: "opencode", args: [], harness: true },
];

/** Initial pty size before the view's first fit; the view resizes immediately. */
const INITIAL_ROWS = 24;
const INITIAL_COLS = 80;

function isProfile(value: unknown): value is TermProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<TermProfile>;
  return typeof profile.id === "string" && typeof profile.command === "string";
}

function loadUserProfiles(): TermProfile[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(USER_PROFILES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isProfile).map((p) => ({
      id: p.id,
      label: p.label ?? p.id,
      command: p.command,
      args: Array.isArray(p.args) ? p.args : [],
      harness: Boolean(p.harness),
    }));
  } catch {
    return [];
  }
}

/** A collision-proof session id. Independent of any counter or backend state,
 *  so a session opened before `rehydrate()` has reseeded can never alias a
 *  session still live in the backend across a webview reload. */
function newSessionId(): string {
  return `term-${crypto.randomUUID()}`;
}

/** A friendly label for the detected shell command (model ResolveProfile). */
function shellLabel(command: string): string {
  const base = command.replace(/\\/g, "/").split("/").pop() ?? command;
  const name = base.replace(/\.exe$/i, "");
  if (name === "pwsh" || name === "powershell") return "PowerShell";
  if (name === "cmd") return "Command Prompt";
  if (name === "") return "Shell";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export class TerminalStore {
  /** Open tabs, in strip order — survive panel collapse. */
  tabs = $state<TermTab[]>([]);
  /** The focused tab's id, or null when none are open. */
  activeId = $state<string | null>(null);
  /** Launch profiles: detected shell first, the harnesses, then user-defined. */
  profiles = $state<TermProfile[]>([...BUILTIN_HARNESSES]);
  /** The id of the most recently registered session, bumped once the backend
   *  has it. The view's initial fit runs on tab mount — BEFORE `termSpawn`
   *  registers the session — so that resize hits a not-yet-live session and is
   *  dropped, leaving the PTY at its 80-col default (a narrow terminal). The
   *  view re-fits this session once it lands here so the real width reaches the
   *  child. */
  lastSpawnedId = $state<string | null>(null);

  private exitUnlisten = new Map<string, UnlistenFn>();
  private initialised = false;

  /** Resolve the built-in shell profile from the detected default shell, and
   *  rebuild the tab strip from any sessions still running Rust-side — once.
   *  A webview reload resets this singleton but NOT the backend registry (only
   *  window close kills sessions), so rehydration reattaches the orphaned
   *  sessions; each xterm then replays its buffer on mount. */
  async init(): Promise<void> {
    if (this.initialised) return;
    this.initialised = true;
    if (!isTauri()) return; // browser dev: no PTY backend, harness profiles only
    let shell: TermProfile | null = null;
    try {
      const { command, args } = await termDefaultShell();
      shell = { id: "shell", label: shellLabel(command), command, args, harness: false };
    } catch {
      /* detection failed — leave the shell profile out, harnesses still work */
    }
    this.profiles = [
      ...(shell ? [shell] : []),
      ...BUILTIN_HARNESSES,
      ...loadUserProfiles(),
    ];
    await this.rehydrate();
  }

  /** Reattach sessions still alive in the backend (survived a webview reload). */
  private async rehydrate(): Promise<void> {
    let live: { id: string; profileId: string; label: string }[];
    try {
      live = await termList();
    } catch {
      return;
    }
    for (const session of live) {
      if (this.tabs.some((t) => t.id === session.id)) continue;
      this.tabs.push({ ...session, error: null });
      await this.watchExit(session.id);
    }
    if (!this.activeId && this.tabs.length > 0) this.activeId = this.tabs[0].id;
  }

  /** The default profile to open from the bare "+" button (detected shell, else
   *  the first profile). */
  get defaultProfileId(): string | null {
    return this.profiles[0]?.id ?? null;
  }

  profile(id: string): TermProfile | undefined {
    return this.profiles.find((p) => p.id === id);
  }

  /**
   * Open a new session from a profile (model `Terminal.Spawn`): resolve the
   * profile, resolve the cwd to the open project root, flag a harness so the
   * backend exposes the MCP discovery path, and spawn. The tab appears
   * immediately; a spawn failure marks it with the error rather than leaving a
   * dead tab.
   */
  async open(profileId: string): Promise<void> {
    const profile = this.profile(profileId);
    if (!profile || !isTauri()) return;
    const id = newSessionId();
    this.tabs.push({ id, profileId, label: profile.label, error: null });
    this.activeId = id;
    await this.watchExit(id);
    const spec: TermSpawnSpec = {
      profileId,
      label: profile.label,
      command: profile.command,
      args: profile.args,
      cwd: app.rootPath,
      env: [],
      rows: INITIAL_ROWS,
      cols: INITIAL_COLS,
    };
    try {
      await termSpawn(id, spec, profile.harness);
      // The session is now live backend-side — let the view re-fit it so the
      // fitted size (the initial fit raced ahead of this spawn and was dropped)
      // reaches the child.
      this.lastSpawnedId = id;
    } catch (error) {
      const tab = this.tabs.find((t) => t.id === id);
      if (tab) tab.error = String(error);
    }
  }

  /** Close a tab (model `Terminal.Kill`): kill the session, drop the tab. */
  async close(id: string): Promise<void> {
    try {
      await termKill(id);
    } catch {
      /* already gone */
    }
    this.dropTab(id);
  }

  setActive(id: string): void {
    if (this.tabs.some((t) => t.id === id)) this.activeId = id;
  }

  /** Subscribe to a session's exit so its tab drops even while collapsed
   *  (model SpontaneousExitCleansUp). */
  private async watchExit(id: string): Promise<void> {
    const unlisten = await listen<TermExit>(`term://exit/${id}`, () => this.dropTab(id));
    // A kill/close may have already removed the tab while we awaited.
    if (this.tabs.some((t) => t.id === id)) {
      this.exitUnlisten.set(id, unlisten);
    } else {
      unlisten();
    }
  }

  /** Remove a tab, drop its exit listener, and re-focus a neighbour. */
  private dropTab(id: string): void {
    const index = this.tabs.findIndex((t) => t.id === id);
    if (index === -1) return;
    this.tabs.splice(index, 1);
    const unlisten = this.exitUnlisten.get(id);
    if (unlisten) {
      unlisten();
      this.exitUnlisten.delete(id);
    }
    if (this.activeId === id) {
      const neighbour = this.tabs[index] ?? this.tabs[index - 1] ?? null;
      this.activeId = neighbour ? neighbour.id : null;
    }
  }
}

export const terminal = new TerminalStore();
