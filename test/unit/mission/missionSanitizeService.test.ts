import { describe, expect, it } from "vitest";
import { MissionSanitizeService } from "../../../src/core/app/missionSanitizeService";
import {
  allItems,
  backupPath,
  backupStampPath,
  stampFor,
} from "../../../src/core/domain/missionSanitize";
import { AFTER_TRIGGER, BEFORE_TRIGGER } from "../../../src/core/domain/missionScriptTrigger";
import { MemFileSystem } from "../../support/memFileSystem";
import { RecordingFileSystem } from "../../support/recordingFileSystem";

const LUA = "C:\\DCS\\Scripts\\MissionScripting.lua";
const BAK = backupPath(LUA);
const STAMP = backupStampPath(LUA);

const PRISTINE = [
  "do",
  "\tsanitizeModule('os')",
  "\tsanitizeModule('io')",
  "\tsanitizeModule('lfs')",
  "\t_G['require'] = nil",
  "\t_G['loadlib'] = nil",
  "\t_G['package'] = nil",
  "end",
].join("\r\n");

function setup(initial?: Record<string, string>) {
  const mem = new MemFileSystem();
  for (const [p, c] of Object.entries(initial ?? {})) mem.seedFile(p, c);
  const fs = new RecordingFileSystem(mem);
  return { fs, mem, svc: new MissionSanitizeService(fs) };
}

describe("MissionSanitizeService.status", () => {
  it("reports a missing file with no items", async () => {
    const { svc } = setup();
    expect(await svc.status(LUA)).toEqual({
      path: LUA,
      exists: false,
      backupExists: false,
      items: [],
    });
  });

  it("reports backupExists even when the live file is missing", async () => {
    const { svc } = setup({ [BAK]: PRISTINE });
    const s = await svc.status(LUA);
    expect(s.exists).toBe(false);
    expect(s.backupExists).toBe(true);
  });

  it("reports per-item state for an existing file", async () => {
    const { svc } = setup({ [LUA]: PRISTINE });
    const s = await svc.status(LUA);
    expect(s.exists).toBe(true);
    expect(s.backupExists).toBe(false);
    expect(s.items).toHaveLength(6);
    for (const item of s.items) expect(item).toMatchObject({ present: true, sanitized: true });
  });
});

describe("MissionSanitizeService.setItems", () => {
  it("backs up on first change with the frozen filename, then writes", async () => {
    const { fs, mem, svc } = setup({ [LUA]: PRISTINE });
    const s = await svc.setItems(LUA, allItems(false));
    expect(fs.argsFor("copy")).toEqual([[LUA, BAK]]);
    expect(mem.read(BAK)).toBe(PRISTINE);
    expect(fs.pathsFor("writeText")).toEqual([LUA, STAMP]);
    expect(s.backupExists).toBe(true);
    for (const item of s.items) expect(item).toMatchObject({ present: true, sanitized: false });
  });

  it("preserves CRLF in the written file", async () => {
    const { mem, svc } = setup({ [LUA]: PRISTINE });
    await svc.setItems(LUA, allItems(false));
    const written = mem.read(LUA)!;
    expect(written).toContain("-- sanitizeModule('os')\r\n");
    expect(written).not.toMatch(/[^\r]\n/);
  });

  it("does not overwrite an existing backup on later changes", async () => {
    const { fs, mem, svc } = setup({ [LUA]: PRISTINE });
    await svc.setItems(LUA, allItems(false));
    const desanitized = mem.read(LUA)!;
    await svc.setItems(LUA, allItems(true));
    expect(fs.argsFor("copy")).toEqual([[LUA, BAK]]); // only the first change copied
    expect(mem.read(BAK)).toBe(PRISTINE); // pristine snapshot intact
    expect(mem.read(LUA)).toBe(PRISTINE); // round-trip restored the original
    expect(mem.read(LUA)).not.toBe(desanitized);
  });

  it("neither backs up nor writes when nothing changes", async () => {
    const { fs, svc } = setup({ [LUA]: PRISTINE });
    const s = await svc.setItems(LUA, allItems(true)); // already sanitized
    expect(fs.argsFor("copy")).toEqual([]);
    expect(fs.pathsFor("writeText")).toEqual([]);
    expect(s.backupExists).toBe(false);
    for (const item of s.items) expect(item.sanitized).toBe(true);
  });

  it("rejects when the file cannot be read", async () => {
    const { svc } = setup();
    await expect(svc.setItems(LUA, allItems(false))).rejects.toThrow(/ENOENT/);
  });
});

describe("MissionSanitizeService.backupExists", () => {
  it("answers for a backup that is and is not there", async () => {
    const { svc } = setup({ [LUA]: PRISTINE });
    expect(await svc.backupExists(LUA)).toBe(false);
    await svc.setItems(LUA, allItems(false));
    expect(await svc.backupExists(LUA)).toBe(true);
  });
});

describe("MissionSanitizeService.restore", () => {
  it("throws when no backup exists", async () => {
    const { svc } = setup({ [LUA]: PRISTINE });
    await expect(svc.restore(LUA)).rejects.toThrow("No backup found.");
  });

  it("copies the pristine backup back over the live file", async () => {
    const { mem, svc } = setup({ [LUA]: PRISTINE });
    await svc.setItems(LUA, allItems(false));
    expect(mem.read(LUA)).not.toBe(PRISTINE);
    const s = await svc.restore(LUA);
    expect(mem.read(LUA)).toBe(PRISTINE);
    expect(s.exists).toBe(true);
    expect(s.backupExists).toBe(true);
    for (const item of s.items) expect(item.sanitized).toBe(true);
  });

  it("refuses an empty backup and leaves the live file alone", async () => {
    // Copying a truncated .bak over the live file breaks the install while
    // still reporting success — the failure mode this check exists for.
    const { mem, svc } = setup({ [LUA]: PRISTINE });
    await svc.setItems(LUA, allItems(false));
    const desanitized = mem.read(LUA)!;
    mem.seedFile(BAK, "");

    await expect(svc.restore(LUA)).rejects.toThrow(/Refusing to restore.*empty/);
    expect(mem.read(LUA)).toBe(desanitized);
  });

  it("refuses a backup with none of the sandbox lines", async () => {
    const { fs, svc } = setup({ [LUA]: PRISTINE, [BAK]: "-- half a file\n" });
    await expect(svc.restore(LUA)).rejects.toThrow(/truncated/);
    expect(fs.argsFor("copy")).toEqual([]);
  });

  it("re-stamps the live file so the restore is not itself read as drift", async () => {
    const { svc } = setup({ [LUA]: PRISTINE });
    await svc.setItems(LUA, allItems(false));
    await svc.restore(LUA);
    expect(await svc.backupIsStale(LUA)).toBe(false);
  });
});

describe("MissionSanitizeService.backupIsStale", () => {
  it("is false while the live file is what DCS Studio last wrote", async () => {
    const { svc } = setup({ [LUA]: PRISTINE });
    await svc.setItems(LUA, allItems(false));
    expect(await svc.backupIsStale(LUA)).toBe(false);
  });

  it("is true once something else rewrites the live file", async () => {
    // The case that matters: a DCS update ships a new MissionScripting.lua and
    // the never-refreshed backup now shadows it, so restoring would rewind the
    // user past the update.
    const { mem, svc } = setup({ [LUA]: PRISTINE });
    await svc.setItems(LUA, allItems(false));
    mem.seedFile(LUA, `${PRISTINE}\n-- DCS 2.10 update\n`);
    expect(await svc.backupIsStale(LUA)).toBe(true);
  });

  it("is false when there is no stamp to compare against", async () => {
    // A backup taken by a build that predates stamps: no evidence either way,
    // so restore stays quiet rather than warning on every file.
    const { svc } = setup({ [LUA]: PRISTINE, [BAK]: PRISTINE });
    expect(await svc.backupIsStale(LUA)).toBe(false);
  });

  it("tolerates a stamp file with trailing whitespace", async () => {
    const { mem, svc } = setup({ [LUA]: PRISTINE });
    await svc.setItems(LUA, allItems(false));
    mem.seedFile(STAMP, `${mem.read(STAMP)}\n`);
    expect(await svc.backupIsStale(LUA)).toBe(false);
  });
});

describe("MissionSanitizeService stamping", () => {
  it("records a stamp beside the backup on every write", async () => {
    const { mem, svc } = setup({ [LUA]: PRISTINE });
    await svc.setItems(LUA, allItems(false));
    expect(mem.read(STAMP)).toBe(stampFor(mem.read(LUA)!));

    await svc.setItems(LUA, allItems(true));
    expect(mem.read(STAMP)).toBe(stampFor(PRISTINE));
  });

  it("writes no stamp when nothing changed", async () => {
    const { mem, svc } = setup({ [LUA]: PRISTINE });
    await svc.setItems(LUA, allItems(true));
    expect(mem.hasFile(STAMP)).toBe(false);
  });

  it("still reports the edit as done when the stamp cannot be written", async () => {
    // The stamp only powers a warning; a sidecar the folder refuses is not a
    // reason to tell the user their desanitize failed.
    const { fs, mem, svc } = setup({ [LUA]: PRISTINE });
    fs.failOn("writeText", `EACCES: ${STAMP}`, STAMP);
    const s = await svc.setItems(LUA, allItems(false));

    expect(mem.read(LUA)).toContain("-- sanitizeModule('os')");
    expect(mem.hasFile(STAMP)).toBe(false);
    for (const item of s.items) expect(item.sanitized).toBe(false);
  });
});

// The managed mod-script trigger dofile lines, over the same live file + backup.
describe("MissionSanitizeService.triggerStatus", () => {
  it("reports both triggers missing on a pristine file", async () => {
    const { svc } = setup({ [LUA]: PRISTINE });
    expect(await svc.triggerStatus(LUA)).toEqual({ before: "missing", after: "missing" });
  });
});

describe("MissionSanitizeService.installTriggers", () => {
  it("backs up on first change with the frozen filename, writes, and reports both valid", async () => {
    const { fs, mem, svc } = setup({ [LUA]: PRISTINE });
    const status = await svc.installTriggers(LUA);
    expect(fs.argsFor("copy")).toEqual([[LUA, BAK]]);
    expect(mem.read(BAK)).toBe(PRISTINE);
    expect(fs.pathsFor("writeText")).toEqual([LUA, STAMP]);
    expect(mem.read(LUA)).toContain(BEFORE_TRIGGER);
    expect(mem.read(LUA)).toContain(AFTER_TRIGGER);
    expect(status).toEqual({ before: "valid", after: "valid" });
  });

  it("is idempotent — a second install neither backs up again nor rewrites", async () => {
    const { fs, svc } = setup({ [LUA]: PRISTINE });
    await svc.installTriggers(LUA);
    await svc.installTriggers(LUA);
    expect(fs.argsFor("copy")).toEqual([[LUA, BAK]]); // only the first change copied
    expect(fs.pathsFor("writeText")).toEqual([LUA, STAMP]); // only the first change wrote
  });
});

describe("MissionSanitizeService.removeTriggers", () => {
  it("removes the trigger lines and reports both missing", async () => {
    const { fs, mem, svc } = setup({ [LUA]: PRISTINE });
    await svc.installTriggers(LUA);
    const status = await svc.removeTriggers(LUA);
    expect(mem.read(LUA)).toBe(PRISTINE); // fully restored
    expect(fs.argsFor("copy")).toEqual([[LUA, BAK]]); // backup was made once, not again
    expect(status).toEqual({ before: "missing", after: "missing" });
  });

  it("neither backs up nor writes when there are no triggers to remove", async () => {
    const { fs, svc } = setup({ [LUA]: PRISTINE });
    await svc.removeTriggers(LUA);
    expect(fs.argsFor("copy")).toEqual([]);
    expect(fs.pathsFor("writeText")).toEqual([]);
  });
});
