import { win32 as path } from "node:path";
import { describe, expect, it } from "vitest";
import { describeFileSystemPortContract } from "../../support/filesystemContract";
import { MemFileSystem } from "../../support/memFileSystem";

// The unit layer's fake held to the same contract as the real adapter. Every
// core-service test in this layer runs against `MemFileSystem`, so this is what
// stops those tests from proving something the user's machine will not do.

// The contract calls `create()` and then `makeRoot()` for each test. A real
// adapter can mkdtemp a root out of nothing; an in-memory one has to be told,
// so the root is seeded into whichever instance the current test just created.
let current = new MemFileSystem();
let roots = 0;

describeFileSystemPortContract(
  "MemFileSystem",
  () => {
    current = new MemFileSystem();
    return current;
  },
  {
    makeRoot: () => {
      const dir = path.join("C:", "mem", `root-${++roots}`);
      current.seedDir(dir);
      return dir;
    },
    join: (...parts: string[]) => path.join(...parts),
  },
);

// Beyond the contract: the Windows path handling that lets a single fake serve
// tests written with backslashes, forward slashes and `path.win32.join` alike.
describe("MemFileSystem path canonicalisation", () => {
  it("treats separator style and a trailing separator as the same path", async () => {
    const fs = new MemFileSystem();
    await fs.writeText("C:\\SG\\DCS\\Scripts\\X.lua", "payload");
    expect(await fs.readText("C:/SG/DCS/Scripts/X.lua")).toBe("payload");
    expect(await fs.isDirectory("C:\\SG\\DCS\\Scripts\\")).toBe(true);
    expect(await fs.readDir("C:/SG/DCS/Scripts")).toEqual(["X.lua"]);
  });

  it("keeps case significant, as the adapter does where CI runs it", async () => {
    // Two registry entries differing only in case must stay two paths here, or
    // the install-detection dedup test would be proving the fake's behaviour.
    const fs = new MemFileSystem();
    fs.seedDir("C:\\Program Files\\ED");
    expect(await fs.isDirectory("C:\\PROGRAM FILES\\ED")).toBe(false);
  });

  it("renaming a path onto itself leaves it alone", async () => {
    const fs = new MemFileSystem();
    await fs.writeText("C:\\a\\b.txt", "keep");
    await fs.move("C:\\a", "C:/a/");
    expect(await fs.readText("C:\\a\\b.txt")).toBe("keep");
  });
});
