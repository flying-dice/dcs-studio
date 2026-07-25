import { describe, expect, it } from "vitest";
import type { FileSystemPort } from "../../src/core/ports/filesystem";

// The behavioural contract every FileSystemPort implementation must satisfy.
//
// Core services are tested against in-memory fakes of this port, so those tests
// only prove the services work against whatever the fake happens to do. This
// suite is the other half: run it against the real adapter and against any
// future one, and the fakes' assumptions become checked claims rather than
// hopeful ones. The clauses here are exactly the ones core relies on —
// notably that writeText and copy create missing parent directories, and that
// remove and isDirectory never throw on a missing path.

export interface FileSystemContractHarness {
  /** A fresh, empty directory for one test. */
  makeRoot(): Promise<string> | string;
  /** Join path segments the way the implementation expects them. */
  join(...parts: string[]): string;
}

export function describeFileSystemPortContract(
  name: string,
  create: () => FileSystemPort,
  harness: FileSystemContractHarness,
): void {
  describe(`FileSystemPort contract: ${name}`, () => {
    const root = async () => await harness.makeRoot();

    it("round-trips text through writeText/readText", async () => {
      const fs = create();
      const file = harness.join(await root(), "a.txt");
      await fs.writeText(file, "hello");
      expect(await fs.readText(file)).toBe("hello");
    });

    it("round-trips content that is not plain ASCII", async () => {
      // Manifests carry mod names and descriptions; a UTF-8 slip corrupts them.
      const fs = create();
      const file = harness.join(await root(), "b.txt");
      await fs.writeText(file, "Bf 109 K-4 — “Kurfürst”\r\nline2");
      expect(await fs.readText(file)).toBe("Bf 109 K-4 — “Kurfürst”\r\nline2");
    });

    it("creates missing parent directories on write", async () => {
      // Core writes into <dataDir>/<repo>/… without mkdirp-ing first.
      const fs = create();
      const file = harness.join(await root(), "deep", "deeper", "c.txt");
      await fs.writeText(file, "x");
      expect(await fs.exists(file)).toBe(true);
    });

    it("overwrites an existing file rather than appending", async () => {
      const fs = create();
      const file = harness.join(await root(), "d.txt");
      await fs.writeText(file, "first");
      await fs.writeText(file, "second");
      expect(await fs.readText(file)).toBe("second");
    });

    it("reports existence for files and directories, and absence otherwise", async () => {
      const fs = create();
      const base = await root();
      const file = harness.join(base, "e.txt");
      await fs.writeText(file, "x");
      expect(await fs.exists(file)).toBe(true);
      expect(await fs.exists(base)).toBe(true);
      expect(await fs.exists(harness.join(base, "nope"))).toBe(false);
    });

    it("distinguishes directories from files, and answers false for missing paths", async () => {
      // Never throws: link planning probes paths that may not exist.
      const fs = create();
      const base = await root();
      const file = harness.join(base, "f.txt");
      await fs.writeText(file, "x");
      expect(await fs.isDirectory(base)).toBe(true);
      expect(await fs.isDirectory(file)).toBe(false);
      expect(await fs.isDirectory(harness.join(base, "missing"))).toBe(false);
    });

    it("lists directory entries by name", async () => {
      const fs = create();
      const base = await root();
      await fs.writeText(harness.join(base, "one.txt"), "1");
      await fs.writeText(harness.join(base, "two.txt"), "2");
      await fs.mkdirp(harness.join(base, "sub"));
      expect((await fs.readDir(base)).sort()).toEqual(["one.txt", "sub", "two.txt"]);
    });

    it("lists an empty directory as an empty array", async () => {
      const fs = create();
      expect(await fs.readDir(await root())).toEqual([]);
    });

    it("mkdirp creates nested directories and is idempotent", async () => {
      const fs = create();
      const dir = harness.join(await root(), "x", "y", "z");
      await fs.mkdirp(dir);
      await fs.mkdirp(dir);
      expect(await fs.isDirectory(dir)).toBe(true);
    });

    it("removes a file", async () => {
      const fs = create();
      const file = harness.join(await root(), "g.txt");
      await fs.writeText(file, "x");
      await fs.remove(file);
      expect(await fs.exists(file)).toBe(false);
    });

    it("removes a directory and everything under it", async () => {
      // Uninstall clears an unpacked mod tree in one call.
      const fs = create();
      const base = await root();
      const dir = harness.join(base, "tree");
      await fs.writeText(harness.join(dir, "nested", "h.txt"), "x");
      await fs.remove(dir);
      expect(await fs.exists(dir)).toBe(false);
    });

    it("removing a missing path succeeds rather than throwing", async () => {
      // Uninstall is idempotent; a partially-removed install must still clean.
      const fs = create();
      await expect(fs.remove(harness.join(await root(), "never-existed"))).resolves.toBeUndefined();
    });

    it("copies a file, creating missing parent directories", async () => {
      const fs = create();
      const base = await root();
      const src = harness.join(base, "src.txt");
      const dest = harness.join(base, "out", "nested", "dest.txt");
      await fs.writeText(src, "payload");
      await fs.copy(src, dest);
      expect(await fs.readText(dest)).toBe("payload");
      // A copy, not a move.
      expect(await fs.exists(src)).toBe(true);
    });

    it("copy overwrites an existing destination", async () => {
      const fs = create();
      const base = await root();
      const src = harness.join(base, "s.txt");
      const dest = harness.join(base, "d.txt");
      await fs.writeText(src, "new");
      await fs.writeText(dest, "old");
      await fs.copy(src, dest);
      expect(await fs.readText(dest)).toBe("new");
    });
  });
}
