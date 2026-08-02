import * as fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../../src/adapters/node/fs";
import { MissionSanitizeService } from "../../../src/core/app/missionSanitizeService";
import {
  allItems,
  backupPath,
  backupStampPath,
  ITEMS,
} from "../../../src/core/domain/missionSanitize";
import { tmpRoot } from "../../support/tmpDir";

// Integration test: the real Node fs adapter wired into MissionSanitizeService
// (exactly as the composition root wires it), exercised against actual temp
// files. Verifies the on-disk behavior: backup filename, first-change-only
// snapshot, CRLF preservation.
const svc = new MissionSanitizeService(new NodeFileSystem());
const status = (p: string) => svc.status(p);
const setItems = (p: string, desired: Record<string, boolean>) => svc.setItems(p, desired);
const restore = (p: string) => svc.restore(p);
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

const tmp = tmpRoot("dcs-sanitize-");
let lua: string;

beforeEach(() => {
  lua = tmp.file("MissionScripting.lua", PRISTINE);
});

describe("MissionSanitizeService over the Node fs adapter (real fs)", () => {
  it("reports status for the real file and for a missing file", async () => {
    const s = await status(lua);
    expect(s).toMatchObject({ path: lua, exists: true, backupExists: false });
    expect(s.items).toHaveLength(ITEMS.length);
    const missing = await status(tmp.join("nope.lua"));
    expect(missing).toMatchObject({ exists: false, items: [] });
  });

  it("desanitize writes <path>.dcsstudio.bak once and preserves CRLF on disk", async () => {
    await setItems(lua, allItems(false));
    const bak = backupPath(lua);
    expect(bak).toBe(`${lua}.dcsstudio.bak`);
    expect(fs.readFileSync(bak, "utf8")).toBe(PRISTINE);
    const edited = fs.readFileSync(lua, "utf8");
    expect(edited).toContain("\t-- sanitizeModule('os')\r\n");
    expect(edited).not.toMatch(/[^\r]\n/);

    // Re-sanitize: backup must remain the pristine first snapshot.
    await setItems(lua, allItems(true));
    expect(fs.readFileSync(bak, "utf8")).toBe(PRISTINE);
    expect(fs.readFileSync(lua, "utf8")).toBe(PRISTINE);
  });

  it("restore copies the backup back; throws without one", async () => {
    await expect(restore(lua)).rejects.toThrow("No backup found.");
    await setItems(lua, allItems(false));
    fs.writeFileSync(lua, "-- mangled");
    const s = await restore(lua);
    expect(fs.readFileSync(lua, "utf8")).toBe(PRISTINE);
    expect(s.backupExists).toBe(true);
  });

  it("refuses to copy a truncated backup over the live file", async () => {
    await setItems(lua, allItems(false));
    const desanitized = fs.readFileSync(lua, "utf8");
    fs.writeFileSync(backupPath(lua), "");

    await expect(restore(lua)).rejects.toThrow(/Refusing to restore/);
    expect(fs.readFileSync(lua, "utf8")).toBe(desanitized);
  });

  it("stamps what it wrote, and reads an outside rewrite as stale", async () => {
    // The stamp sidecar is the only record of what DCS Studio last wrote —
    // without it a DCS update that replaces the file is indistinguishable from
    // "nothing has happened since", and restore rewinds past the update.
    await setItems(lua, allItems(false));
    expect(fs.existsSync(backupStampPath(lua))).toBe(true);
    expect(await svc.backupIsStale(lua)).toBe(false);

    fs.writeFileSync(lua, `${PRISTINE}\r\n-- shipped by a DCS update`);
    expect(await svc.backupIsStale(lua)).toBe(true);
  });
});
