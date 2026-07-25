import { win32 as path } from "node:path";
import type { FileSystemPort } from "../../src/core/ports/filesystem";

// The one in-memory `FileSystemPort` the core-service unit tests run against.
//
// It exists because four separate hand-written fakes each guessed at the port's
// semantics — whether `writeText` creates parents, whether `remove` throws on a
// missing path, whether `readDir` throws or answers `[]` for a directory that is
// not there — and a service can pass every unit test against a fake more
// permissive than `NodeFileSystem` and still fail on a user's machine. This one
// is run through `describeFileSystemPortContract`, the same suite the real
// adapter is held to, so its answers are checked claims.
//
// Paths are win32 (DCS is Windows-only, the tests run on Linux) and canonical:
// `C:\a\b`, `C:/a/b` and `C:\a\b\` are the same path, as they are on Windows.
// Case, however, is significant — the reference adapter runs on a case-sensitive
// filesystem in CI, so a fake that folded case would be the more permissive one.

/** Canonical map key for a path: normalised, no trailing separator off a root. */
function key(p: string): string {
  const normalized = path.normalize(p);
  const trimmed = normalized.replace(/[\\/]+$/, "");
  // `C:\` is its own parent; trimming it to `C:` would make it a relative path.
  return trimmed === "" || trimmed.endsWith(":") ? normalized : trimmed;
}

/** The prefix every entry directly or indirectly under `k` starts with. */
function childPrefix(k: string): string {
  return k.endsWith(path.sep) ? k : k + path.sep;
}

export class MemFileSystem implements FileSystemPort {
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>();

  // ── FileSystemPort ─────────────────────────────────────────────────────────

  async readText(p: string): Promise<string> {
    const contents = this.files.get(key(p));
    if (contents === undefined) throw new Error(`ENOENT: no such file, open '${p}'`);
    return contents;
  }

  async writeText(p: string, contents: string): Promise<void> {
    this.seedFile(p, contents);
  }

  async exists(p: string): Promise<boolean> {
    const k = key(p);
    return this.files.has(k) || this.dirs.has(k);
  }

  async isDirectory(p: string): Promise<boolean> {
    return this.dirs.has(key(p));
  }

  /** Rejects for a path that is not a directory, as `readdirSync` does. */
  async readDir(p: string): Promise<string[]> {
    const k = key(p);
    if (!this.dirs.has(k)) throw new Error(`ENOENT: no such directory, scandir '${p}'`);
    const prefix = childPrefix(k);
    const names = new Set<string>();
    for (const entry of this.entries()) {
      if (entry.startsWith(prefix)) names.add(entry.slice(prefix.length).split(path.sep)[0]);
    }
    return [...names];
  }

  async remove(p: string): Promise<void> {
    for (const entry of this.subtree(key(p))) {
      this.files.delete(entry);
      this.dirs.delete(entry);
    }
  }

  async mkdirp(p: string): Promise<void> {
    this.seedDir(p);
  }

  /** Single file only, like `copyFileSync`: rejects when `src` is not a file. */
  async copy(src: string, dest: string): Promise<void> {
    await this.writeText(dest, await this.readText(src));
  }

  async move(src: string, dest: string): Promise<void> {
    const from = key(src);
    if (!this.files.has(from) && !this.dirs.has(from)) {
      throw new Error(`ENOENT: no such file or directory, rename '${src}' -> '${dest}'`);
    }
    const to = key(dest);
    if (to === from) return; // renaming a path onto itself changes nothing
    // `rename` will not merge a tree into an occupied directory, and callers
    // depend on that: the install swap stages a payload and renames it onto the
    // live mod dir, so a silent merge would leave the previous version's files
    // mixed into the new one instead of failing loudly.
    if (this.dirs.has(to) && this.subtree(to).length > 1) {
      throw new Error(`ENOTEMPTY: directory not empty, rename '${src}' -> '${dest}'`);
    }
    await this.remove(dest);
    this.seedDir(path.dirname(to));
    for (const entry of this.subtree(from)) {
      const moved = to + entry.slice(from.length);
      const contents = this.files.get(entry);
      if (contents === undefined) this.dirs.add(moved);
      else this.files.set(moved, contents);
      this.files.delete(entry);
      this.dirs.delete(entry);
    }
  }

  // ── Test-only setup and inspection (synchronous, and never recorded) ────────

  /** Place a file and its parent directories without going through the port. */
  seedFile(p: string, contents: string): this {
    const k = key(p);
    this.seedDir(path.dirname(k));
    this.files.set(k, contents);
    return this;
  }

  /** Place a directory and its parents without going through the port. */
  seedDir(p: string): this {
    let dir = key(p);
    while (!this.dirs.has(dir)) {
      this.dirs.add(dir);
      const parent = key(path.dirname(dir));
      if (parent === dir) break;
      dir = parent;
    }
    return this;
  }

  /** Contents of a file, or `undefined` when there is no file there. */
  read(p: string): string | undefined {
    return this.files.get(key(p));
  }

  /** Whether a file exists at `p` (a directory does not count). */
  hasFile(p: string): boolean {
    return this.files.has(key(p));
  }

  /** Whether a directory exists at `p`. */
  hasDir(p: string): boolean {
    return this.dirs.has(key(p));
  }

  private entries(): string[] {
    return [...this.files.keys(), ...this.dirs];
  }

  /** `k` itself plus everything under it. */
  private subtree(k: string): string[] {
    const prefix = childPrefix(k);
    return this.entries().filter((entry) => entry === k || entry.startsWith(prefix));
  }
}
