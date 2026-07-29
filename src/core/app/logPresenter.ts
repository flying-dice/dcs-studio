import * as path from "node:path";
import { LogBuffer, type LogEntry, type ModIdentity, modIdentity } from "../domain/dcsLog";
import type { InstallRootsPort } from "../ports/installRoots";
import type { LogFileState, LogHostMessage, LogWebviewMessage } from "./webviewContract";

// The DCS Log viewer's decision logic, lifted out of the VS Code panel.
//
// The viewer tails Saved Games/DCS/Logs/dcs.log and mirrors it into a webview.
// Parsing and buffering were already pure (`core/domain/dcsLog.ts`); what was
// welded to the panel is everything AROUND them — which lines become an
// `append` and which become continuation updates, how many the cap evicted
// since the last push, whether a tick is silent, what the boot handshake
// replays, which file path is being watched, and the "any failure means no mod
// identity" mapping over the workspace manifest. All of that is here now, and
// none of it knows about VS Code.
//
// What deliberately stays in the shell (`src/log/logPanel.ts`): the tailer's
// lifetime and its poll cadence — an adapter concern, per card 08 — and the
// panel's own teardown ordering (`disposed` before `tailer.stop()`), which
// exists because the first tail is queued behind an async manifest read. The
// presenter exposes `retarget()` for the shell to call when it is about to
// point a new tailer somewhere, and takes the tailer's three callbacks as
// `onLines`/`onState`/`onReset`.

export type { LogFileState };

/** Something only the editor can do, described rather than done. */
export type LogEffect = { kind: "openSettings" };

/**
 * The message shapes the log webview sends the host — the declared contract,
 * not a local restatement of it. Named here as well so the panel keeps
 * importing its boundary type from the module it talks to.
 */
export type LogInbound = LogWebviewMessage;

export interface LogPresenterDeps {
  /** Where the DCS installs are; `savedGames()` is re-read on every retarget so
   * a settings change lands on the next tail rather than at the next reload. */
  roots: InstallRootsPort;
  /**
   * Parse manifest TOML far enough to find the project name — `ManifestPort`'s
   * `parseToml` satisfies it. Declared this narrowly, and with everything
   * optional, because that is all the log identity needs and because the parser
   * is a hand-written TOML reader over a file the user edits: `project` really
   * can be absent at runtime, whatever the model type promises.
   */
  parseManifest: (text: string) => { project?: { name?: string | null } };
  /**
   * The workspace manifest's text, or `null` when there is no workspace to read
   * one from. May reject — a missing or unreadable `dcs-studio.toml` is the
   * common case, and "no mod identity" is the answer for all of them.
   */
  manifestText: () => Promise<string | null>;
  /**
   * Deliver a message to the webview. Typed to the declared host union, so a
   * message `media/log.js` has no case for cannot be sent from here without the
   * contract being updated first.
   */
  post: (msg: LogHostMessage) => void;
  /** Perform an editor-side effect. */
  effect: (effect: LogEffect) => void;
}

export class LogPresenter {
  private readonly buffer = new LogBuffer();
  private mod: ModIdentity | null = null;
  /** The buffer's cumulative drop count as of the last `append` — the delta is
   * what the webview's badge needs, and the buffer only counts totals. */
  private lastDropped = 0;
  private fileState: LogFileState = "missing";
  private filePath = "";

  constructor(private readonly deps: LogPresenterDeps) {}

  /** Re-derive "my mod" identity from the workspace manifest and push it; any
   * failure at all means no identity, because the viewer is useful without one
   * and a half-written TOML must not stop the log from opening. */
  async loadModIdentity(): Promise<void> {
    try {
      const text = await this.deps.manifestText();
      this.mod = text === null ? null : modIdentity(this.deps.parseManifest(text).project?.name);
    } catch {
      this.mod = null;
    }
    this.deps.post({ type: "mod", mod: this.mod });
  }

  /**
   * Point at the log file to tail now, dropping everything buffered from the
   * last one: entries from another Saved Games folder belong to a different
   * install. Returns the path for the shell to hand its new tailer.
   */
  retarget(): string {
    this.buffer.clear();
    this.lastDropped = 0;
    this.filePath = path.join(this.deps.roots.savedGames(), "Logs", "dcs.log");
    return this.filePath;
  }

  /** A batch of raw lines off the tail. */
  onLines(lines: string[]): void {
    const entries: LogEntry[] = [];
    const cont: { seq: number; cont: string[] }[] = [];
    for (const line of lines) {
      const ev = this.buffer.push(line, this.mod);
      if (ev.kind === "added") entries.push(ev.entry);
      // A continuation carries its entry's WHOLE trace so far and the webview
      // swaps the list wholesale, so re-sending earlier lines cannot duplicate.
      else cont.push({ seq: ev.entry.seq, cont: ev.entry.cont });
    }
    const dropped = this.buffer.droppedCount - this.lastDropped;
    this.lastDropped = this.buffer.droppedCount;
    // A tick that added nothing stays silent, or the webview would re-render
    // several times a second while DCS sits idle.
    if (entries.length || cont.length || dropped) {
      this.deps.post({ type: "append", entries, cont, dropped });
    }
  }

  /** The file appeared or disappeared. The path goes with it — it is the only
   * clue when the Saved Games setting points somewhere wrong. */
  onState(state: LogFileState): void {
    this.fileState = state;
    this.deps.post({ type: "fileState", state, file: this.filePath });
  }

  /** DCS truncated the log (a restart): keeping the old entries would silently
   * mix two sessions together. */
  onReset(): void {
    this.buffer.clear();
    this.lastDropped = 0;
    this.deps.post({ type: "reset" });
  }

  handle(msg: LogInbound): void {
    switch (msg.type) {
      case "ready":
        // The webview loads after the tail has already been running, so without
        // this replay the user sees an empty grid until the next line lands.
        this.deps.post({
          type: "init",
          entries: this.buffer.list(),
          mod: this.mod,
          file: this.filePath,
          state: this.fileState,
        });
        break;
      case "clear":
        this.buffer.clear();
        this.lastDropped = 0;
        break;
      case "openSettings":
        this.deps.effect({ kind: "openSettings" });
        break;
    }
  }
}
