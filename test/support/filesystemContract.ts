import { describe, expect, it } from "vitest";
import type { FileSystemPort } from "../../src/core/ports/filesystem";

// The behavioural contract every FileSystemPort implementation must satisfy.
//
// Core services are tested against an in-memory fake of this port, so those
// tests only prove the services work against whatever the fake happens to do.
// This suite is the other half: `MemFileSystem` (the unit layer's fake) and
// `NodeFileSystem` (the real adapter) are both run through it, so the fake's
// assumptions are checked claims rather than hopeful ones. The clauses here are
// exactly the ones core relies on — notably that writeText and copy create
// missing parent directories, that remove and isDirectory never throw on a
// missing path, and that readDir does.

export interface FileSystemContractHarness {
  /** A fresh, empty directory for the implementation just handed back by `create`. */
  makeRoot(): string;
  /** Join path segments the way the implementation expects them. */
  join(...parts: string[]): string;
}

export function describeFileSystemPortContract(
  name: string,
  create: () => FileSystemPort,
  harness: FileSystemContractHarness,
): void {
  describe(`FileSystemPort contract: ${name}`, () => {
    const root = () => harness.makeRoot();

    it("round-trips text through writeText/readText", async () => {
      const fs = create();
      const file = harness.join(root(), "a.txt");
      await fs.writeText(file, "hello");
      expect(await fs.readText(file)).toBe("hello");
    });

    it("round-trips content that is not plain ASCII", async () => {
      // Manifests carry mod names and descriptions; a UTF-8 slip corrupts them.
      const fs = create();
      const file = harness.join(root(), "b.txt");
      await fs.writeText(file, "Bf 109 K-4 — “Kurfürst”\r\nline2");
      expect(await fs.readText(file)).toBe("Bf 109 K-4 — “Kurfürst”\r\nline2");
    });

    it("creates missing parent directories on write", async () => {
      // Core writes into <dataDir>/<repo>/… without mkdirp-ing first.
      const fs = create();
      const file = harness.join(root(), "deep", "deeper", "c.txt");
      await fs.writeText(file, "x");
      expect(await fs.exists(file)).toBe(true);
    });

    it("overwrites an existing file rather than appending", async () => {
      const fs = create();
      const file = harness.join(root(), "d.txt");
      await fs.writeText(file, "first");
      await fs.writeText(file, "second");
      expect(await fs.readText(file)).toBe("second");
    });

    it("reports existence for files and directories, and absence otherwise", async () => {
      const fs = create();
      const base = root();
      const file = harness.join(base, "e.txt");
      await fs.writeText(file, "x");
      expect(await fs.exists(file)).toBe(true);
      expect(await fs.exists(base)).toBe(true);
      expect(await fs.exists(harness.join(base, "nope"))).toBe(false);
    });

    it("distinguishes directories from files, and answers false for missing paths", async () => {
      // Never throws: link planning probes paths that may not exist.
      const fs = create();
      const base = root();
      const file = harness.join(base, "f.txt");
      await fs.writeText(file, "x");
      expect(await fs.isDirectory(base)).toBe(true);
      expect(await fs.isDirectory(file)).toBe(false);
      expect(await fs.isDirectory(harness.join(base, "missing"))).toBe(false);
    });

    it("lists directory entries by name", async () => {
      const fs = create();
      const base = root();
      await fs.writeText(harness.join(base, "one.txt"), "1");
      await fs.writeText(harness.join(base, "two.txt"), "2");
      await fs.mkdirp(harness.join(base, "sub"));
      expect((await fs.readDir(base)).sort()).toEqual(["one.txt", "sub", "two.txt"]);
    });

    it("lists an empty directory as an empty array", async () => {
      const fs = create();
      expect(await fs.readDir(root())).toEqual([]);
    });

    it("rejects a listing of something that is not there", async () => {
      // Detection tells "no Saved Games folder" from "an empty one" by catching
      // this; an implementation answering [] would report no DCS installs on a
      // machine that has them and no way to tell why.
      const fs = create();
      await expect(fs.readDir(harness.join(root(), "never-existed"))).rejects.toThrow();
    });

    it("measures a single file as one file and its byte length", async () => {
      const fs = create();
      const file = harness.join(root(), "m.txt");
      await fs.writeText(file, "12345");
      expect(await fs.measure(file)).toEqual({ directory: false, files: 1, bytes: 5 });
    });

    it("measures a file in BYTES, not characters", async () => {
      // The archive preview's totals are compared against a volume-split
      // threshold in bytes. A fake counting `contents.length` would agree with
      // the adapter on every ASCII fixture and quietly disagree on a manifest
      // with a mod name in it — which is most of them.
      const fs = create();
      const file = harness.join(root(), "utf8.txt");
      await fs.writeText(file, "Kurfürst"); // 8 chars, 9 UTF-8 bytes
      expect(await fs.measure(file)).toEqual({ directory: false, files: 1, bytes: 9 });
    });

    it("measures a directory as the recursive totals of its files", async () => {
      // Counts LEAVES: a [[bundle]] folder entry reports the files it brings,
      // and the directories along the way are not among them.
      const fs = create();
      const base = root();
      const dir = harness.join(base, "tree");
      await fs.writeText(harness.join(dir, "a.txt"), "aa");
      await fs.writeText(harness.join(dir, "nested", "b.txt"), "bbb");
      await fs.writeText(harness.join(dir, "nested", "deeper", "c.txt"), "c");
      expect(await fs.measure(dir)).toEqual({ directory: true, files: 3, bytes: 6 });
    });

    it("tells a one-file directory apart from that file", async () => {
      // The whole reason `directory` is reported rather than inferred: both of
      // these measure one file, and the archive preview says "brings its whole
      // tree" about only one of them.
      const fs = create();
      const dir = harness.join(root(), "solo");
      const file = harness.join(dir, "only.txt");
      await fs.writeText(file, "x");
      expect((await fs.measure(dir))?.directory).toBe(true);
      expect((await fs.measure(file))?.directory).toBe(false);
    });

    it("measures an empty directory as nothing at all, which is not absence", async () => {
      // `{ files: 0 }` and `null` are different rows in the preview: an empty
      // folder is there and packs nothing, a missing one needs building first.
      const fs = create();
      expect(await fs.measure(root())).toEqual({ directory: true, files: 0, bytes: 0 });
    });

    it("answers null for a path that is not there rather than throwing", async () => {
      const fs = create();
      expect(await fs.measure(harness.join(root(), "never-existed"))).toBeNull();
    });

    it("mkdirp creates nested directories and is idempotent", async () => {
      const fs = create();
      const dir = harness.join(root(), "x", "y", "z");
      await fs.mkdirp(dir);
      await fs.mkdirp(dir);
      expect(await fs.isDirectory(dir)).toBe(true);
    });

    it("removes a file", async () => {
      const fs = create();
      const file = harness.join(root(), "g.txt");
      await fs.writeText(file, "x");
      await fs.remove(file);
      expect(await fs.exists(file)).toBe(false);
    });

    it("removes a directory and everything under it", async () => {
      // Uninstall clears an unpacked mod tree in one call.
      const fs = create();
      const base = root();
      const dir = harness.join(base, "tree");
      await fs.writeText(harness.join(dir, "nested", "h.txt"), "x");
      await fs.remove(dir);
      expect(await fs.exists(dir)).toBe(false);
    });

    it("removing a missing path succeeds rather than throwing", async () => {
      // Uninstall is idempotent; a partially-removed install must still clean.
      const fs = create();
      await expect(fs.remove(harness.join(root(), "never-existed"))).resolves.toBeUndefined();
    });

    it("copies a file, creating missing parent directories", async () => {
      const fs = create();
      const base = root();
      const src = harness.join(base, "src.txt");
      const dest = harness.join(base, "out", "nested", "dest.txt");
      await fs.writeText(src, "payload");
      await fs.copy(src, dest);
      expect(await fs.readText(dest)).toBe("payload");
      // A copy, not a move.
      expect(await fs.exists(src)).toBe(true);
    });

    it("moves a directory and everything under it, leaving nothing behind", async () => {
      // The install swap: a staged payload is renamed onto the live mod dir, so
      // a failed extraction can never have destroyed the working one.
      const fs = create();
      const base = root();
      const src = harness.join(base, "staging");
      const dest = harness.join(base, "live");
      await fs.writeText(harness.join(src, "Scripts", "mod.lua"), "payload");
      await fs.move(src, dest);
      expect(await fs.readText(harness.join(dest, "Scripts", "mod.lua"))).toBe("payload");
      expect(await fs.exists(src)).toBe(false);
    });

    it("moves a file, creating missing parent directories", async () => {
      const fs = create();
      const base = root();
      const src = harness.join(base, "from.txt");
      const dest = harness.join(base, "out", "nested", "to.txt");
      await fs.writeText(src, "payload");
      await fs.move(src, dest);
      expect(await fs.readText(dest)).toBe("payload");
      expect(await fs.exists(src)).toBe(false);
    });

    it("rejects a move of something that is not there", async () => {
      // Callers stage into a known-empty path; a silent no-op would let a
      // failed extraction look like a successful swap.
      const fs = create();
      const base = root();
      await expect(
        fs.move(harness.join(base, "never-existed"), harness.join(base, "dest")),
      ).rejects.toThrow();
    });

    it("refuses to merge a moved directory into an occupied one", async () => {
      // The install swap renames a staged payload onto the live mod dir, and the
      // caller clears that dir first precisely because a merge would leave the
      // previous version's files mixed into the new one and call it a success.
      const fs = create();
      const base = root();
      const src = harness.join(base, "staging");
      const dest = harness.join(base, "live");
      await fs.writeText(harness.join(src, "new.lua"), "new");
      await fs.writeText(harness.join(dest, "old.lua"), "old");
      await expect(fs.move(src, dest)).rejects.toThrow();
      expect(await fs.readText(harness.join(dest, "old.lua"))).toBe("old");
    });

    it("copy overwrites an existing destination", async () => {
      const fs = create();
      const base = root();
      const src = harness.join(base, "s.txt");
      const dest = harness.join(base, "d.txt");
      await fs.writeText(src, "new");
      await fs.writeText(dest, "old");
      await fs.copy(src, dest);
      expect(await fs.readText(dest)).toBe("new");
    });
  });
}
