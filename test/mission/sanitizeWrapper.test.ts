import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MissionSanitizeService } from "../../src/core/app/missionSanitizeService";
import { NodeFileSystem } from "../../src/adapters/node/fs";
import { allItems, backupPath, ITEMS } from "../../src/core/domain/missionSanitize";

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

let dir: string;
let lua: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-sanitize-"));
  lua = path.join(dir, "MissionScripting.lua");
  fs.writeFileSync(lua, PRISTINE);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("MissionSanitizeService over the Node fs adapter (real fs)", () => {
  it("reports status for the real file and for a missing file", async () => {
    const s = await status(lua);
    expect(s).toMatchObject({ path: lua, exists: true, backupExists: false });
    expect(s.items).toHaveLength(ITEMS.length);
    const missing = await status(path.join(dir, "nope.lua"));
    expect(missing).toMatchObject({ exists: false, items: [] });
  });

  it("desanitize writes <path>.dcsstudio.bak once and preserves CRLF on disk", async () => {
    await setItems(lua, allItems(false));
    const bak = backupPath(lua);
    expect(bak).toBe(lua + ".dcsstudio.bak");
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
});
