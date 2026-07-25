import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());

const onDisk = new Set<string>();
vi.mock("fs", () => ({ existsSync: (p: string) => onDisk.has(p) }));

import { installRoots } from "../../../src/adapters/vscode/installRoots";
import type { MissionSanitizeService } from "../../../src/core/app/missionSanitizeService";
import type { MissionItemState } from "../../../src/core/domain/missionSanitize";
import {
  desanitizeMission,
  installMissionHooks,
  missionScriptPath,
  openMissionScripting,
  removeMissionHooks,
  restoreMission,
  sanitizeMission,
} from "../../../src/mission/missionPanel";

// MissionScripting.lua is DCS's own file, inside the game install. Desanitizing
// it hands mission scripts os/io/lfs — the whole point of the bridge — but a
// bad write breaks the user's install, and the file often sits under Program
// Files where the write simply fails. So the assertions here are about the
// guards around the write: never edit behind an unsaved buffer, always name the
// backup, and turn a permission failure into an instruction rather than an
// errno.

const INSTALL = "D:\\DCS World";
const LUA = "D:\\DCS World\\Scripts\\MissionScripting.lua";

interface Recorded {
  setItems: Record<string, boolean>[];
  restored: string[];
  installedTriggers: string[];
  removedTriggers: string[];
}

let calls: Recorded;
let items: MissionItemState[];
let failure: unknown;
/** Whether a pristine backup is on disk — what the "(backup: …)" note claims. */
let backupExists: boolean;
/** Whether the live file has moved on since DCS Studio last wrote it. */
let staleBackup: boolean;

function item(name: string, over: Partial<MissionItemState> = {}): MissionItemState {
  return { name, present: true, sanitized: true, ...over };
}

function service(): MissionSanitizeService {
  const reject = () => {
    if (failure) throw failure;
  };
  return {
    status: async (p: string) => ({ path: p, exists: true, backupExists, items }),
    backupExists: async () => backupExists,
    backupIsStale: async () => staleBackup,
    setItems: async (_p: string, desired: Record<string, boolean>) => {
      reject();
      calls.setItems.push(desired);
      return { path: LUA, exists: true, backupExists, items };
    },
    restore: async (p: string) => {
      reject();
      calls.restored.push(p);
    },
    installTriggers: async (p: string) => {
      reject();
      calls.installedTriggers.push(p);
      return { before: "valid", after: "missing" };
    },
    removeTriggers: async (p: string) => {
      reject();
      calls.removedTriggers.push(p);
    },
  } as unknown as MissionSanitizeService;
}

/** The file exists on disk and no editor holds it. */
function installedAndClosed(): void {
  resetVscode({ config: { "dcsStudio.gameInstallPath": INSTALL } });
  onDisk.add(LUA);
}

beforeEach(() => {
  onDisk.clear();
  calls = { setItems: [], restored: [], installedTriggers: [], removedTriggers: [] };
  items = [item("os"), item("io"), item("require")];
  failure = undefined;
  backupExists = true;
  staleBackup = false;
  installedAndClosed();
});

describe("locating the file", () => {
  it("resolves Scripts\\MissionScripting.lua under the configured install", () => {
    // Windows separators regardless of the host: this path is handed to the
    // real fs and to DCS, and a posix join would find nothing.
    expect(missionScriptPath(installRoots)).toBe(LUA);
  });

  it("has no path until the install is configured", () => {
    resetVscode();
    expect(missionScriptPath(installRoots)).toBeUndefined();
  });

  it("offers to open Setup when no install path is configured", async () => {
    resetVscode();
    state.messageReplies.push("Set DCS Paths");
    await desanitizeMission(service(), installRoots);

    expect(state.info[0]).toContain("Set your DCS installation path");
    expect(state.executedCommands.at(-1)?.command).toBe("dcs.setup.open");
    expect(calls.setItems).toEqual([]);
  });

  it("does nothing further when that offer is dismissed", async () => {
    resetVscode();
    state.messageReplies.push(undefined);
    await desanitizeMission(service(), installRoots);
    expect(state.executedCommands).toEqual([]);
  });

  it("reports a configured install that has no MissionScripting.lua", async () => {
    // Almost always a stale or mistyped install path, so the message names the
    // path it looked at and points at Settings rather than at DCS.
    onDisk.clear();
    await desanitizeMission(service(), installRoots);

    expect(state.errors[0]).toContain(LUA);
    expect(state.errors[0]).toContain("Check your DCS install path");
    expect(calls.setItems).toEqual([]);
  });
});

describe("opening it", () => {
  it("opens the real file and names the modules still locked", async () => {
    items = [item("os"), item("io", { sanitized: false }), item("lfs", { present: false })];
    await openMissionScripting(service(), installRoots);

    expect(state.openedDocuments).toEqual([LUA]);
    expect(state.shownDocuments).toEqual([LUA]);
    // Only what is both present and still commented-in is locked — an absent
    // line is not a lock, and one already commented out is not either.
    expect(state.info[0]).toContain("(os locked)");
  });

  it("stays quiet when nothing is locked", async () => {
    items = [item("os", { sanitized: false })];
    await openMissionScripting(service(), installRoots);
    expect(state.info).toEqual([]);
  });

  it("opens nothing when the file is missing", async () => {
    onDisk.clear();
    await openMissionScripting(service(), installRoots);
    expect(state.openedDocuments).toEqual([]);
  });
});

describe("toggling the sandbox", () => {
  it("desanitize unlocks every item and names the backup file", async () => {
    await desanitizeMission(service(), installRoots);

    expect(calls.setItems).toEqual([
      { os: false, io: false, lfs: false, require: false, loadlib: false, package: false },
    ]);
    // The backup is the user's only way back to DCS's shipped file, so the
    // toast names it — as a bare filename, which needs the win32 basename.
    expect(state.info[0]).toContain("os/io/lfs/require/package are available");
    expect(state.info[0]).toContain("(backup: MissionScripting.lua.dcsstudio.bak)");
  });

  it("re-sanitize locks every item back down", async () => {
    await sanitizeMission(service(), installRoots);

    expect(calls.setItems).toEqual([
      { os: true, io: true, lfs: true, require: true, loadlib: true, package: true },
    ]);
    expect(state.info[0]).toContain("default lockdown restored");
  });

  it("names no backup when the toggle was a no-op and none exists", async () => {
    // Desanitizing an already-desanitized file writes nothing, so no pristine
    // snapshot is taken. Naming one anyway promises the user a way back that
    // is not on disk.
    backupExists = false;
    await desanitizeMission(service(), installRoots);

    expect(state.info[0]).toContain("os/io/lfs/require/package are available");
    expect(state.info[0]).not.toContain("backup:");
  });

  it("restores the pristine backup over the live file", async () => {
    await restoreMission(service(), installRoots);
    expect(calls.restored).toEqual([LUA]);
    expect(state.info[0]).toContain("Restored MissionScripting.lua from the backup");
    expect(state.warnings).toEqual([]);
  });
});

describe("restoring over a file that has moved on", () => {
  // The backup is snapshotted once and never refreshed. After a DCS update
  // replaces MissionScripting.lua, restoring it rewinds the user past that
  // update — so the restore asks first instead of doing it silently.
  it("confirms before undoing a change made outside DCS Studio", async () => {
    staleBackup = true;
    state.messageReplies.push("Restore anyway");
    await restoreMission(service(), installRoots);

    expect(state.warnings[0]).toContain("most likely a DCS update");
    expect(calls.restored).toEqual([LUA]);
    expect(state.info[0]).toContain("Restored MissionScripting.lua from the backup");
  });

  it("leaves the file alone when that confirmation is dismissed", async () => {
    staleBackup = true;
    state.messageReplies.push(undefined);
    await restoreMission(service(), installRoots);

    expect(calls.restored).toEqual([]);
    expect(state.info[0]).toContain("Restore cancelled");
  });
});

describe("the unsaved-buffer guard", () => {
  const openDirty = (fsPath: string) => {
    state.textDocuments = [{ uri: { fsPath }, isDirty: true }];
  };

  it.each([
    ["desanitize", desanitizeMission],
    ["re-sanitize", sanitizeMission],
    ["restore", restoreMission],
    ["install hooks", installMissionHooks],
    ["remove hooks", removeMissionHooks],
  ])("refuses to %s while the file has unsaved edits", async (_label, action) => {
    // Writing under an unsaved buffer is worse than doing nothing: VS Code
    // saves that stale buffer later and quietly reverses the change — a
    // desanitize re-locks the sandbox, a restore puts the mangled file back.
    openDirty(LUA);
    await action(service(), installRoots);

    expect(state.warnings[0]).toContain("unsaved changes");
    expect(calls).toMatchObject({
      setItems: [],
      restored: [],
      installedTriggers: [],
      removedTriggers: [],
    });
  });

  it("matches the open document regardless of path casing", async () => {
    // VS Code reports whatever casing the file was opened with; on Windows that
    // is the same file, and a case-sensitive compare would miss the guard.
    openDirty("d:\\dcs world\\scripts\\missionscripting.lua");
    await desanitizeMission(service(), installRoots);
    expect(calls.setItems).toEqual([]);
  });

  it("proceeds when the open copy has been saved", async () => {
    state.textDocuments = [{ uri: { fsPath: LUA }, isDirty: false }];
    await desanitizeMission(service(), installRoots);
    expect(calls.setItems).toHaveLength(1);
  });
});

describe("keeping the editor in step", () => {
  it("reverts the visible editor so it shows what was just written", async () => {
    const document = { uri: { fsPath: LUA }, isDirty: false };
    state.textDocuments = [document];
    state.visibleTextEditors = [{ document, viewColumn: 2 }];
    await desanitizeMission(service(), installRoots);

    expect(state.shownDocuments).toEqual([LUA]);
    expect(state.executedCommands.at(-1)?.command).toBe("workbench.action.files.revert");
  });

  it("reverts nothing when the file is not on screen", async () => {
    await desanitizeMission(service(), installRoots);
    expect(state.executedCommands).toEqual([]);
  });
});

describe("mod-script hooks", () => {
  it("installs the trigger lines and reports both of their states", async () => {
    await installMissionHooks(service(), installRoots);

    expect(calls.installedTriggers).toEqual([LUA]);
    expect(state.info[0]).toContain("before-sanitize: valid, after-sanitize: missing");
    expect(state.info[0]).toContain("Backup: MissionScripting.lua.dcsstudio.bak");
  });

  it("names no backup when installing the hooks changed nothing", async () => {
    backupExists = false;
    await installMissionHooks(service(), installRoots);

    expect(state.info[0]).toContain("before-sanitize: valid, after-sanitize: missing");
    expect(state.info[0]).not.toContain("Backup:");
  });

  it("removes the trigger lines", async () => {
    await removeMissionHooks(service(), installRoots);
    expect(calls.removedTriggers).toEqual([LUA]);
    expect(state.info[0]).toContain("hooks removed");
  });
});

describe("when the write fails", () => {
  it.each(["EPERM", "EACCES"])("explains a %s failure as a permissions problem", async (code) => {
    // The stock install lives under Program Files, where a non-elevated VS Code
    // cannot write. "EPERM: operation not permitted" tells the user nothing;
    // "run as administrator" is the actual fix.
    failure = Object.assign(new Error("operation not permitted"), { code });
    await desanitizeMission(service(), installRoots);

    expect(state.errors[0]).toContain("Run VS Code as administrator");
    expect(state.info).toEqual([]);
  });

  it("passes any other error through with its own message", async () => {
    failure = new Error("EBUSY: file is locked by DCS");
    await restoreMission(service(), installRoots);
    expect(state.errors[0]).toBe("EBUSY: file is locked by DCS");
  });

  it("renders a non-Error failure", async () => {
    failure = "No backup found.";
    await restoreMission(service(), installRoots);
    expect(state.errors[0]).toBe("No backup found.");
  });

  it("leaves the editor alone when the hook install fails", async () => {
    const document = { uri: { fsPath: LUA }, isDirty: false };
    state.textDocuments = [document];
    state.visibleTextEditors = [{ document }];
    failure = new Error("disk full");
    await installMissionHooks(service(), installRoots);

    expect(state.executedCommands).toEqual([]);
    expect(state.errors[0]).toBe("disk full");
  });
});
