import { describe, expect, it } from "vitest";
import { MissionSanitizeService } from "../../../src/core/app/missionSanitizeService";
import {
  allItems,
  backupPath,
  backupStampPath,
  stampFor,
} from "../../../src/core/domain/missionSanitize";
import { AFTER_TRIGGER, BEFORE_TRIGGER } from "../../../src/core/domain/missionScriptTrigger";
import type { FileSystemPort } from "../../../src/core/ports/filesystem";

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

/** In-memory FileSystemPort recording copies/writes. */
class MemFs implements FileSystemPort {
  files = new Map<string, string>();
  copies: Array<[string, string]> = [];
  writes: string[] = [];
  /** Paths whose writes reject — a folder the process may not write into. */
  failWrites = new Set<string>();

  async readText(p: string): Promise<string> {
    const c = this.files.get(p);
    if (c === undefined) throw new Error(`ENOENT: ${p}`);
    return c;
  }
  async writeText(p: string, contents: string): Promise<void> {
    if (this.failWrites.has(p)) throw new Error(`EACCES: ${p}`);
    this.files.set(p, contents);
    this.writes.push(p);
  }
  async exists(p: string): Promise<boolean> {
    return this.files.has(p);
  }
  async isDirectory(): Promise<boolean> {
    return false;
  }
  async readDir(): Promise<string[]> {
    return [];
  }
  async remove(p: string): Promise<void> {
    this.files.delete(p);
  }
  async mkdirp(): Promise<void> {}
  async copy(src: string, dest: string): Promise<void> {
    this.files.set(dest, await this.readText(src));
    this.copies.push([src, dest]);
  }
  async move(src: string, dest: string): Promise<void> {
    this.files.set(dest, await this.readText(src));
    this.files.delete(src);
  }
}

function setup(initial?: Record<string, string>) {
  const fs = new MemFs();
  for (const [p, c] of Object.entries(initial ?? {})) fs.files.set(p, c);
  return { fs, svc: new MissionSanitizeService(fs) };
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
    const { fs, svc } = setup({ [LUA]: PRISTINE });
    const s = await svc.setItems(LUA, allItems(false));
    expect(fs.copies).toEqual([[LUA, BAK]]);
    expect(fs.files.get(BAK)).toBe(PRISTINE);
    expect(fs.writes).toEqual([LUA, STAMP]);
    expect(s.backupExists).toBe(true);
    for (const item of s.items) expect(item).toMatchObject({ present: true, sanitized: false });
  });

  it("preserves CRLF in the written file", async () => {
    const { fs, svc } = setup({ [LUA]: PRISTINE });
    await svc.setItems(LUA, allItems(false));
    const written = fs.files.get(LUA)!;
    expect(written).toContain("-- sanitizeModule('os')\r\n");
    expect(written).not.toMatch(/[^\r]\n/);
  });

  it("does not overwrite an existing backup on later changes", async () => {
    const { fs, svc } = setup({ [LUA]: PRISTINE });
    await svc.setItems(LUA, allItems(false));
    const desanitized = fs.files.get(LUA)!;
    await svc.setItems(LUA, allItems(true));
    expect(fs.copies).toEqual([[LUA, BAK]]); // only the first change copied
    expect(fs.files.get(BAK)).toBe(PRISTINE); // pristine snapshot intact
    expect(fs.files.get(LUA)).toBe(PRISTINE); // round-trip restored the original
    expect(fs.files.get(LUA)).not.toBe(desanitized);
  });

  it("neither backs up nor writes when nothing changes", async () => {
    const { fs, svc } = setup({ [LUA]: PRISTINE });
    const s = await svc.setItems(LUA, allItems(true)); // already sanitized
    expect(fs.copies).toEqual([]);
    expect(fs.writes).toEqual([]);
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
    const { fs, svc } = setup({ [LUA]: PRISTINE });
    await svc.setItems(LUA, allItems(false));
    expect(fs.files.get(LUA)).not.toBe(PRISTINE);
    const s = await svc.restore(LUA);
    expect(fs.files.get(LUA)).toBe(PRISTINE);
    expect(s.exists).toBe(true);
    expect(s.backupExists).toBe(true);
    for (const item of s.items) expect(item.sanitized).toBe(true);
  });

  it("refuses an empty backup and leaves the live file alone", async () => {
    // Copying a truncated .bak over the live file breaks the install while
    // still reporting success — the failure mode this check exists for.
    const { fs, svc } = setup({ [LUA]: PRISTINE });
    await svc.setItems(LUA, allItems(false));
    const desanitized = fs.files.get(LUA)!;
    fs.files.set(BAK, "");

    await expect(svc.restore(LUA)).rejects.toThrow(/Refusing to restore.*empty/);
    expect(fs.files.get(LUA)).toBe(desanitized);
  });

  it("refuses a backup with none of the sandbox lines", async () => {
    const { fs, svc } = setup({ [LUA]: PRISTINE, [BAK]: "-- half a file\n" });
    await expect(svc.restore(LUA)).rejects.toThrow(/truncated/);
    expect(fs.copies).toEqual([]);
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
    const { fs, svc } = setup({ [LUA]: PRISTINE });
    await svc.setItems(LUA, allItems(false));
    fs.files.set(LUA, `${PRISTINE}\n-- DCS 2.10 update\n`);
    expect(await svc.backupIsStale(LUA)).toBe(true);
  });

  it("is false when there is no stamp to compare against", async () => {
    // A backup taken by a build that predates stamps: no evidence either way,
    // so restore stays quiet rather than warning on every file.
    const { svc } = setup({ [LUA]: PRISTINE, [BAK]: PRISTINE });
    expect(await svc.backupIsStale(LUA)).toBe(false);
  });

  it("tolerates a stamp file with trailing whitespace", async () => {
    const { fs, svc } = setup({ [LUA]: PRISTINE });
    await svc.setItems(LUA, allItems(false));
    fs.files.set(STAMP, `${fs.files.get(STAMP)}\n`);
    expect(await svc.backupIsStale(LUA)).toBe(false);
  });
});

describe("MissionSanitizeService stamping", () => {
  it("records a stamp beside the backup on every write", async () => {
    const { fs, svc } = setup({ [LUA]: PRISTINE });
    await svc.setItems(LUA, allItems(false));
    expect(fs.files.get(STAMP)).toBe(stampFor(fs.files.get(LUA)!));

    await svc.setItems(LUA, allItems(true));
    expect(fs.files.get(STAMP)).toBe(stampFor(PRISTINE));
  });

  it("writes no stamp when nothing changed", async () => {
    const { fs, svc } = setup({ [LUA]: PRISTINE });
    await svc.setItems(LUA, allItems(true));
    expect(fs.files.has(STAMP)).toBe(false);
  });

  it("still reports the edit as done when the stamp cannot be written", async () => {
    // The stamp only powers a warning; a sidecar the folder refuses is not a
    // reason to tell the user their desanitize failed.
    const { fs, svc } = setup({ [LUA]: PRISTINE });
    fs.failWrites.add(STAMP);
    const s = await svc.setItems(LUA, allItems(false));

    expect(fs.files.get(LUA)).toContain("-- sanitizeModule('os')");
    expect(fs.files.has(STAMP)).toBe(false);
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
    const { fs, svc } = setup({ [LUA]: PRISTINE });
    const status = await svc.installTriggers(LUA);
    expect(fs.copies).toEqual([[LUA, BAK]]);
    expect(fs.files.get(BAK)).toBe(PRISTINE);
    expect(fs.writes).toEqual([LUA, STAMP]);
    expect(fs.files.get(LUA)).toContain(BEFORE_TRIGGER);
    expect(fs.files.get(LUA)).toContain(AFTER_TRIGGER);
    expect(status).toEqual({ before: "valid", after: "valid" });
  });

  it("is idempotent — a second install neither backs up again nor rewrites", async () => {
    const { fs, svc } = setup({ [LUA]: PRISTINE });
    await svc.installTriggers(LUA);
    await svc.installTriggers(LUA);
    expect(fs.copies).toEqual([[LUA, BAK]]); // only the first change copied
    expect(fs.writes).toEqual([LUA, STAMP]); // only the first change wrote
  });
});

describe("MissionSanitizeService.removeTriggers", () => {
  it("removes the trigger lines and reports both missing", async () => {
    const { fs, svc } = setup({ [LUA]: PRISTINE });
    await svc.installTriggers(LUA);
    const status = await svc.removeTriggers(LUA);
    expect(fs.files.get(LUA)).toBe(PRISTINE); // fully restored
    expect(fs.copies).toEqual([[LUA, BAK]]); // backup was made once, not again
    expect(status).toEqual({ before: "missing", after: "missing" });
  });

  it("neither backs up nor writes when there are no triggers to remove", async () => {
    const { fs, svc } = setup({ [LUA]: PRISTINE });
    await svc.removeTriggers(LUA);
    expect(fs.copies).toEqual([]);
    expect(fs.writes).toEqual([]);
  });
});
