import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

// The .lnk is written by a PowerShell one-liner, so the script text IS the
// feature: a mis-quoted path or a wrong argument list produces a shortcut that
// silently opens the wrong thing (or nothing) long after the user asked for it.
// Both the script and the ICO bytes are therefore asserted exactly.

interface FakeChild {
  stderrListeners: ((chunk: Buffer) => void)[];
  listeners: Map<string, (arg: unknown) => void>;
  stderr: { on(event: string, cb: (chunk: Buffer) => void): void };
  on(event: string, cb: (arg: unknown) => void): FakeChild;
}

const spawns: { file: string; args: string[]; options: unknown }[] = [];
/** What the spawned powershell does; replaced per-test to play a failure. */
let powershell: (child: FakeChild) => void = (child) => child.listeners.get("exit")?.(0);

vi.mock("child_process", () => ({
  spawn: (file: string, args: string[], options: unknown) => {
    spawns.push({ file, args, options });
    const child: FakeChild = {
      stderrListeners: [],
      listeners: new Map(),
      stderr: { on: (_event, cb) => child.stderrListeners.push(cb) },
      on: (event, cb) => {
        child.listeners.set(event, cb);
        return child;
      },
    };
    // The real child settles after the caller has attached every listener.
    setTimeout(() => powershell(child), 0);
    return child;
  },
}));

const written: { file: string; data: Uint8Array }[] = [];
const madeDirs: string[] = [];
let iconPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

vi.mock("fs", () => ({
  mkdirSync: (dir: string) => madeDirs.push(dir),
  readFileSync: () => iconPng,
  writeFileSync: (file: string, data: Uint8Array) => written.push({ file, data }),
}));

import * as vscode from "vscode";
import {
  createMyModsShortcut,
  MYMODS_URI_PATH,
  myModsDeepLink,
} from "../../../src/install/shortcut";

const CODE_EXE = "C:\\Program Files\\Microsoft VS Code\\Code.exe";
const STORAGE =
  "C:\\Users\\pilot\\AppData\\Roaming\\Code\\User\\globalStorage\\flying-dice.dcs-studio";
const EXT_DIR = "C:\\Users\\pilot\\.vscode\\extensions\\flying-dice.dcs-studio-0.16.0";

function context(over: { storage?: string } = {}): vscode.ExtensionContext {
  return {
    globalStorageUri: vscode.Uri.file(over.storage ?? STORAGE),
    extensionPath: EXT_DIR,
    extension: { id: "flying-dice.dcs-studio" },
  } as unknown as vscode.ExtensionContext;
}

/** The whole `-Command` payload handed to powershell.exe. */
function script(): string {
  return spawns[0].args[spawns[0].args.length - 1];
}

/** Play PowerShell writing to stderr before it exits. */
function emitStderr(child: FakeChild, text: string): void {
  for (const cb of child.stderrListeners) cb(Buffer.from(text));
}

const DESKTOP = { label: "Desktop", picked: true, folder: "Desktop" as const };
const START_MENU = { label: "Start Menu", picked: true, folder: "Programs" as const };

let originalPlatform: PropertyDescriptor | undefined;
let originalExecPath: PropertyDescriptor | undefined;

beforeEach(() => {
  resetVscode({
    extensions: {
      "flying-dice.dcs-studio": {
        packageJSON: { version: "0.16.0", bugs: { url: "https://github.com/o/r/issues" } },
      },
    },
  });
  spawns.length = 0;
  written.length = 0;
  madeDirs.length = 0;
  iconPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  powershell = (child) => child.listeners.get("exit")?.(0);
  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  originalExecPath = Object.getOwnPropertyDescriptor(process, "execPath");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  Object.defineProperty(process, "execPath", { value: CODE_EXE, configurable: true });
  // Not in the shared double: the product's URI scheme and the remote flag are
  // exactly what this feature branches on, so each test sets them explicitly.
  Object.assign(vscode.env, { uriScheme: "vscode", remoteName: undefined });
});

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  if (originalExecPath) Object.defineProperty(process, "execPath", originalExecPath);
});

describe("the deep link", () => {
  it("addresses the extension's own URI handler under the running product's scheme", () => {
    // Insiders registers `vscode-insiders://`; a hardcoded `vscode://` would
    // hand the link to a different install of VS Code, or to none at all.
    Object.assign(vscode.env, { uriScheme: "vscode-insiders" });
    expect(myModsDeepLink(context())).toBe("vscode-insiders://flying-dice.dcs-studio/mymods");
    expect(MYMODS_URI_PATH).toBe("/mymods");
  });
});

describe("where it can run", () => {
  it("refuses off Windows, where there is no .lnk and no WScript.Shell", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    await createMyModsShortcut(context());

    expect(state.errors[0]).toBe(
      "My Mods shortcuts are only supported on a local Windows install.",
    );
    expect(spawns).toEqual([]);
  });

  it("refuses in a remote window, where the desktop is not the user's", async () => {
    // In SSH/WSL/containers the extension host runs on the remote machine, so a
    // shortcut would land on a desktop nobody is looking at.
    Object.assign(vscode.env, { remoteName: "wsl" });
    await createMyModsShortcut(context());

    expect(state.errors[0]).toBe(
      "My Mods shortcuts are only supported on a local Windows install.",
    );
    expect(spawns).toEqual([]);
  });
});

describe("choosing the destinations", () => {
  it("writes nothing when the picker is dismissed", async () => {
    state.quickPickReplies.push(undefined);
    await createMyModsShortcut(context());

    expect(spawns).toEqual([]);
    expect(written).toEqual([]);
  });

  it("writes nothing when every location is unticked", async () => {
    state.quickPickReplies.push([]);
    await createMyModsShortcut(context());

    expect(spawns).toEqual([]);
    expect(written).toEqual([]);
  });

  it("writes one shortcut per ticked location and names them in the toast", async () => {
    state.quickPickReplies.push([DESKTOP, START_MENU]);
    await createMyModsShortcut(context());

    expect(spawns).toHaveLength(2);
    expect(script()).toContain("GetFolderPath('Desktop')");
    expect(spawns[1].args[spawns[1].args.length - 1]).toContain("GetFolderPath('Programs')");
    expect(state.info).toEqual([
      "Shortcut added to Desktop and Start Menu. It opens My Mods in its own window.",
    ]);
  });
});

describe("the generated PowerShell", () => {
  beforeEach(async () => {
    state.quickPickReplies.push([DESKTOP]);
    await createMyModsShortcut(context());
  });

  it("runs powershell without profile, prompts or a window", () => {
    // A profile that prints, or a prompt nobody can answer, would hang the
    // command forever behind an invisible console.
    expect(spawns[0].file).toBe("powershell.exe");
    expect(spawns[0].args.slice(0, 5)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
    ]);
    expect(spawns[0].options).toEqual({ windowsHide: true });
  });

  it("builds the shortcut exactly", () => {
    expect(script()).toBe(
      [
        "$ErrorActionPreference='Stop'",
        "$dir = [Environment]::GetFolderPath('Desktop')",
        "$ws = New-Object -ComObject WScript.Shell",
        "$s = $ws.CreateShortcut((Join-Path $dir 'DCS Studio - My Mods.lnk'))",
        `$s.TargetPath = '${CODE_EXE}'`,
        "$s.Arguments = '--new-window --open-url -- vscode://flying-dice.dcs-studio/mymods'",
        "$s.WorkingDirectory = 'C:\\Program Files\\Microsoft VS Code'",
        `$s.IconLocation = '${STORAGE}\\dcs-studio.ico,0'`,
        "$s.Description = 'Enable, update & remove your installed DCS mods'",
        "$s.Save()",
      ].join("; "),
    );
  });
});

describe("the icon", () => {
  it("wraps the bundled PNG in an ICO container in global storage", async () => {
    // .lnk cannot reference a PNG, and global storage is the one location that
    // survives an extension update — an icon under the versioned extension dir
    // would break every shortcut on the next release.
    state.quickPickReplies.push([DESKTOP]);
    await createMyModsShortcut(context());

    expect(madeDirs).toEqual([STORAGE]);
    expect(written).toHaveLength(1);
    expect(written[0].file).toBe(`${STORAGE}\\dcs-studio.ico`);
    const bytes = written[0].data;
    expect(Array.from(bytes.slice(0, 22))).toEqual([
      0,
      0,
      1,
      0,
      1,
      0,
      0,
      0,
      0,
      0,
      1,
      0,
      32,
      0,
      iconPng.length,
      0,
      0,
      0,
      22,
      0,
      0,
      0,
    ]);
    expect(Array.from(bytes.slice(22))).toEqual(Array.from(iconPng));
  });

  it("escapes an apostrophe in the storage path so the script still parses", async () => {
    // Windows account names like "O'Brien" reach globalStorageUri verbatim; an
    // unescaped quote would terminate the PowerShell string mid-path.
    state.quickPickReplies.push([DESKTOP]);
    await createMyModsShortcut(context({ storage: "C:\\Users\\O'Brien\\storage" }));

    expect(script()).toContain(
      "$s.IconLocation = 'C:\\Users\\O''Brien\\storage\\dcs-studio.ico,0'",
    );
  });
});

describe("when Windows says no", () => {
  it("reports the PowerShell error text per location", async () => {
    powershell = (child) => {
      emitStderr(child, "Access to the path is denied.\n");
      child.listeners.get("exit")?.(1);
    };
    state.quickPickReplies.push([DESKTOP, START_MENU]);
    await createMyModsShortcut(context());

    expect(state.errors[0]).toBe(
      "Couldn't create the shortcut — Desktop: Access to the path is denied.; Start Menu: Access to the path is denied.",
    );
    expect(state.info).toEqual([]);
  });

  it("falls back to the exit code when PowerShell fails silently", async () => {
    // Without this the user would get "Couldn't create the shortcut — Desktop:"
    // and no clue at all.
    powershell = (child) => child.listeners.get("exit")?.(1);
    state.quickPickReplies.push([DESKTOP]);
    await createMyModsShortcut(context());

    expect(state.errors[0]).toBe("Couldn't create the shortcut — Desktop: exit 1");
  });

  it("reports powershell.exe being missing from PATH", async () => {
    // Locked-down machines strip PowerShell; the spawn never starts, so no exit
    // code ever arrives and only the error event can end the wait.
    powershell = (child) => child.listeners.get("error")?.(new Error("spawn ENOENT"));
    state.quickPickReplies.push([DESKTOP]);
    await createMyModsShortcut(context());

    expect(state.errors[0]).toBe("Couldn't create the shortcut — Desktop: spawn ENOENT");
  });

  it("still reports the locations that did succeed", async () => {
    let call = 0;
    powershell = (child) => {
      call += 1;
      if (call === 1) return void child.listeners.get("exit")?.(0);
      emitStderr(child, "denied");
      child.listeners.get("exit")?.(1);
    };
    state.quickPickReplies.push([DESKTOP, START_MENU]);
    await createMyModsShortcut(context());

    expect(state.errors[0]).toBe("Couldn't create the shortcut — Start Menu: denied");
  });
});
