import * as fs from "fs";
import * as path from "path";
import type { FileSystemPort, PathMeasure } from "../../core/ports/filesystem";

// Node adapter for `FileSystemPort` — thin intent-level wrappers over node:fs.
export class NodeFileSystem implements FileSystemPort {
  async readText(p: string): Promise<string> {
    return fs.readFileSync(p, "utf8");
  }

  async writeText(p: string, contents: string): Promise<void> {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents);
  }

  async exists(p: string): Promise<boolean> {
    return fs.existsSync(p);
  }

  async isDirectory(p: string): Promise<boolean> {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  async readDir(p: string): Promise<string[]> {
    return fs.readdirSync(p);
  }

  /**
   * The one method here that does NOT use the sync `node:fs` calls the rest of
   * this adapter is built from, and the exception is deliberate.
   *
   * Every other method touches one path. This one walks a tree of unknown size —
   * a `[[bundle]]` entry may be `target/`, and a Rust project's is routinely six
   * figures. Measured on this repo's own `node_modules` (14k files) the sync
   * walk costs ~430ms of BLOCKED extension host and the async one ~740ms of
   * wall-clock that yields. The manifest form asks for this on every pause in
   * typing, so a blocking version freezes the editor while someone edits a
   * description. Slower and responsive is the right way round for a preview.
   */
  async measure(p: string): Promise<PathMeasure | null> {
    let stat: fs.Stats;
    try {
      // `stat`, not `lstat`, so a bundle path that IS a junction measures what
      // it points at — that is the thing the author declared. The walk below
      // deliberately does not follow links, so there is no way back up into an
      // ancestor from inside.
      stat = await fs.promises.stat(p);
    } catch {
      return null;
    }
    if (!stat.isDirectory()) return { directory: false, files: 1, bytes: stat.size };
    return { directory: true, ...(await this.measureDir(p)) };
  }

  private async measureDir(dir: string): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      // A `Dirent` reports the entry's OWN type, so a junction or symlink is
      // never `isDirectory()` here however real the directory behind it. That is
      // what stops the walk looping through a link that points back at an
      // ancestor — a Saved Games junction inside a project would otherwise
      // recurse until the stack gave out. Such an entry is counted as the one
      // entry it is, which is also what 7-Zip stores by default.
      if (entry.isDirectory()) {
        const sub = await this.measureDir(child);
        files += sub.files;
        bytes += sub.bytes;
      } else {
        files++;
        bytes += (await fs.promises.lstat(child)).size;
      }
    }
    return { files, bytes };
  }

  async remove(p: string): Promise<void> {
    fs.rmSync(p, { recursive: true, force: true });
  }

  async mkdirp(p: string): Promise<void> {
    fs.mkdirSync(p, { recursive: true });
  }

  async copy(src: string, dest: string): Promise<void> {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  async move(src: string, dest: string): Promise<void> {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
  }
}
