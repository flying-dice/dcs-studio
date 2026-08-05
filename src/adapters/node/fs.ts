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

  async measure(p: string): Promise<PathMeasure | null> {
    let stat: fs.Stats;
    try {
      // `statSync`, so a bundle path that IS a junction measures what it points
      // at — that is the thing the author declared. The walk below deliberately
      // does not follow links, so there is no way back up into an ancestor.
      stat = fs.statSync(p);
    } catch {
      return null;
    }
    if (!stat.isDirectory()) return { directory: false, files: 1, bytes: stat.size };
    return { directory: true, ...this.measureDir(p) };
  }

  private measureDir(dir: string): { files: number; bytes: number } {
    let files = 0;
    let bytes = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      // A `Dirent` reports the entry's OWN type, so a junction or symlink is
      // never `isDirectory()` here however real the directory behind it. That is
      // what stops the walk looping through a link that points back at an
      // ancestor — a Saved Games junction inside a project would otherwise
      // recurse until the stack gave out. Such an entry is counted as the one
      // entry it is, which is also what 7-Zip stores by default.
      if (entry.isDirectory()) {
        const sub = this.measureDir(child);
        files += sub.files;
        bytes += sub.bytes;
      } else {
        files++;
        bytes += fs.lstatSync(child).size;
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
