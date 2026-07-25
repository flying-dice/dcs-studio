import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

/** Directories and files `fs.statSync` will admit to; anything else is ENOENT. */
const dirs = new Set<string>();
const files = new Set<string>();

interface FakeWatcher {
  target: string;
  recursive: boolean | undefined;
  notify: () => void;
  closed: boolean;
}
const watchers: FakeWatcher[] = [];

// `fs.watch` is the whole point of this module and there is no way to provoke a
// real one deterministically: the OS decides when (and how often) a rebuild's
// writes surface, which is exactly the noise the debounce exists to absorb.
vi.mock("fs", () => ({
  statSync: (p: string) => {
    if (dirs.has(p)) return { isDirectory: () => true };
    if (files.has(p)) return { isDirectory: () => false };
    throw new Error(`ENOENT: no such file or directory, stat '${p}'`);
  },
  watch: (target: string, opts: { recursive?: boolean }, cb: () => void) => {
    const watcher: FakeWatcher = {
      target,
      recursive: opts.recursive,
      notify: cb,
      closed: false,
      close() {
        this.closed = true;
      },
    } as FakeWatcher & { close(): void };
    watchers.push(watcher);
    return watcher;
  },
}));

import * as vscode from "vscode";
import { setupDevReload } from "../../../src/devReload";

// The dev host's "reload after each edit" loop. Two things have to hold: it
// must never run in an installed copy — a shipped extension that reloads the
// user's window whenever a file under its install dir changes would throw away
// unsaved editor state on every extension update — and inside the dev host a
// single `tsc` rebuild (which rewrites dozens of files over a second or so)
// must produce exactly one reload, not one per file.

const EXT = "C:\\ext";
const OUT = path.join(EXT, "out");
const MEDIA = path.join(EXT, "media");
const PACKAGE_JSON = path.join(EXT, "package.json");

function context(mode: number): vscode.ExtensionContext {
  return {
    extensionUri: vscode.Uri.file(EXT),
    extensionMode: mode,
    subscriptions: [] as vscode.Disposable[],
  } as unknown as vscode.ExtensionContext;
}

function reloads(): number {
  return state.executedCommands.filter((c) => c.command === "workbench.action.reloadWindow").length;
}

beforeEach(() => {
  resetVscode();
  vi.useFakeTimers();
  dirs.clear();
  files.clear();
  watchers.length = 0;
  dirs.add(OUT);
  dirs.add(MEDIA);
  files.add(PACKAGE_JSON);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("setupDevReload", () => {
  it("does nothing at all outside an Extension Development Host", () => {
    const ctx = context(vscode.ExtensionMode.Production);
    setupDevReload(ctx);

    expect(watchers).toEqual([]);
    expect(ctx.subscriptions).toEqual([]);
    // No status-bar note either: an installed copy must give no sign that a
    // developer-only mode exists.
    expect(state.statusBarMessages).toEqual([]);
  });

  it("watches the built output, the webview assets and the manifest", () => {
    setupDevReload(context(vscode.ExtensionMode.Development));

    expect(watchers.map((w) => w.target)).toEqual([OUT, MEDIA, PACKAGE_JSON]);
    // Directories are watched recursively (out/ is nested); package.json is a
    // single file, where a recursive watch is meaningless.
    expect(watchers.map((w) => w.recursive)).toEqual([true, true, false]);
    expect(state.statusBarMessages).toEqual(["DCS Studio: dev auto-reload on out/ + media/"]);
  });

  it("skips a target that is not present in this build", () => {
    dirs.delete(MEDIA);
    setupDevReload(context(vscode.ExtensionMode.Development));

    // A build without media/ still gets the out/ watch rather than blowing up
    // activation of the dev host.
    expect(watchers.map((w) => w.target)).toEqual([OUT, PACKAGE_JSON]);
  });

  it("collapses a burst of rebuild writes into one reload", () => {
    setupDevReload(context(vscode.ExtensionMode.Development));

    watchers[0].notify();
    vi.advanceTimersByTime(399);
    // Still mid-rebuild: reloading now would restart the host against a
    // half-written out/.
    expect(reloads()).toBe(0);

    watchers[0].notify();
    watchers[1].notify();
    watchers[2].notify();
    vi.advanceTimersByTime(400);
    expect(reloads()).toBe(1);
  });

  it("reloads again for a later, separate edit", () => {
    setupDevReload(context(vscode.ExtensionMode.Development));

    watchers[0].notify();
    vi.advanceTimersByTime(400);
    watchers[0].notify();
    vi.advanceTimersByTime(400);
    expect(reloads()).toBe(2);
  });

  it("closes every watcher when the extension is disposed", () => {
    const ctx = context(vscode.ExtensionMode.Development);
    setupDevReload(ctx);

    for (const d of ctx.subscriptions) d.dispose();
    // Watchers survive a window reload otherwise, and each reload adds another
    // set — after a few edits one save fires the reload command many times.
    expect(watchers.every((w) => w.closed)).toBe(true);
  });
});
