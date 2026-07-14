import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Linker } from "../../src/adapters/node/linker";

// Exercises the linker against a real temp filesystem: junction/symlink for
// directories, hard link for same-volume files, and the merge behaviour for
// destinations that already exist as real directories (issue #3).
let root: string;
let src: string;
let dcs: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "linker-test-"));
  src = path.join(root, "data", "mod");
  dcs = path.join(root, "SavedGames");
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dcs, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeSrcFile(rel: string, content = "x"): string {
  const p = path.join(src, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

describe("Linker.enable", () => {
  it("links a directory into a missing destination as a single link", async () => {
    writeSrcFile("Hooks/mod-hook.lua");
    const dest = path.join(dcs, "Scripts", "Hooks");
    const res = await new Linker().enable([{ id: "m:0", src: path.join(src, "Hooks"), dest }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created).toEqual([{ id: "m:0", src: path.join(src, "Hooks"), dest }]);
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(dest, "mod-hook.lua"), "utf8")).toBe("x");
  });

  it("merges into a destination directory that already exists (issue #3)", async () => {
    writeSrcFile("Hooks/mod-hook.lua");
    writeSrcFile("Hooks/nested/deep.lua");
    const dest = path.join(dcs, "Scripts", "Hooks");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "existing-hook.lua"), "keep me");

    const res = await new Linker().enable([{ id: "m:0", src: path.join(src, "Hooks"), dest }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Children are linked individually; the pre-existing dir and its content stay real.
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(dest, "existing-hook.lua"), "utf8")).toBe("keep me");
    expect(fs.readFileSync(path.join(dest, "mod-hook.lua"), "utf8")).toBe("x");
    expect(fs.lstatSync(path.join(dest, "nested")).isSymbolicLink()).toBe(true);
    expect(res.created.map((l) => l.id).sort()).toEqual(["m:0/mod-hook.lua", "m:0/nested"]);

    // Disable removes only our links, never the shared dir or its other files.
    const removed = new Linker().disable(res.created.map((l) => ({ id: l.id, installedPath: l.dest })));
    expect(removed.failed).toEqual([]);
    expect(fs.existsSync(path.join(dest, "mod-hook.lua"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "nested"))).toBe(false);
    expect(fs.readFileSync(path.join(dest, "existing-hook.lua"), "utf8")).toBe("keep me");
    expect(fs.existsSync(path.join(src, "Hooks", "nested", "deep.lua"))).toBe(true);
  });

  it("merges recursively when nested destination directories also exist", async () => {
    writeSrcFile("Scripts/Hooks/mod-hook.lua");
    const dest = path.join(dcs, "Scripts");
    fs.mkdirSync(path.join(dest, "Hooks"), { recursive: true });

    const res = await new Linker().enable([{ id: "m:0", src: path.join(src, "Scripts"), dest }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created.map((l) => l.id)).toEqual(["m:0/Hooks/mod-hook.lua"]);
    expect(fs.readFileSync(path.join(dest, "Hooks", "mod-hook.lua"), "utf8")).toBe("x");
  });

  it("still fails when a merge hits a real file conflict, and rolls back", async () => {
    writeSrcFile("Hooks/a-hook.lua");
    writeSrcFile("Hooks/b-hook.lua");
    const dest = path.join(dcs, "Scripts", "Hooks");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "b-hook.lua"), "theirs");

    const res = await new Linker().enable([{ id: "m:0", src: path.join(src, "Hooks"), dest }]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toBe(`Destination path already exists: ${path.join(dest, "b-hook.lua")}`);
    // The sibling link created before the conflict was rolled back; theirs is intact.
    expect(fs.existsSync(path.join(dest, "a-hook.lua"))).toBe(false);
    expect(fs.readFileSync(path.join(dest, "b-hook.lua"), "utf8")).toBe("theirs");
  });

  it("still fails when the destination exists and is not a mergeable directory", async () => {
    writeSrcFile("table.lua");
    const dest = path.join(dcs, "Scripts", "table.lua");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, "theirs");

    const res = await new Linker().enable([{ id: "m:0", src: path.join(src, "table.lua"), dest }]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toBe(`Destination path already exists: ${dest}`);
  });

  it("re-enabling is idempotent: adopts links we already created (issue #3)", async () => {
    writeSrcFile("Hooks/mod-hook.lua");
    writeSrcFile("Hooks/nested/deep.lua");
    const dest = path.join(dcs, "Scripts", "Hooks");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "existing-hook.lua"), "keep me");
    const defs = [{ id: "m:0", src: path.join(src, "Hooks"), dest }];

    const first = await new Linker().enable(defs);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // A second enable with the links still present must succeed, not throw
    // "Destination path already exists", and re-report the same links.
    const second = await new Linker().enable(defs);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created.map((l) => l.id).sort()).toEqual(["m:0/mod-hook.lua", "m:0/nested"]);
    expect(fs.readFileSync(path.join(dest, "mod-hook.lua"), "utf8")).toBe("x");
    expect(fs.readFileSync(path.join(dest, "nested", "deep.lua"), "utf8")).toBe("x");
    expect(fs.readFileSync(path.join(dest, "existing-hook.lua"), "utf8")).toBe("keep me");
  });

  it("re-enabling a top-level directory link is idempotent (issue #3)", async () => {
    writeSrcFile("Hooks/mod-hook.lua");
    const dest = path.join(dcs, "Scripts", "Hooks");
    const defs = [{ id: "m:0", src: path.join(src, "Hooks"), dest }];

    const first = await new Linker().enable(defs);
    expect(first.ok).toBe(true);
    const second = await new Linker().enable(defs);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toEqual([{ id: "m:0", src: path.join(src, "Hooks"), dest }]);
    expect(fs.readFileSync(path.join(dest, "mod-hook.lua"), "utf8")).toBe("x");
  });

  it("rolls back earlier definitions when a later one fails", async () => {
    writeSrcFile("Hooks/mod-hook.lua");
    const okDest = path.join(dcs, "Scripts", "Hooks");
    const badSrc = path.join(src, "missing");
    const res = await new Linker().enable([
      { id: "m:0", src: path.join(src, "Hooks"), dest: okDest },
      { id: "m:1", src: badSrc, dest: path.join(dcs, "Mods", "x") },
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toBe(`Source path does not exist: ${badSrc}`);
    expect(fs.existsSync(okDest)).toBe(false);
  });
});
