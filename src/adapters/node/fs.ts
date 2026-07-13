import * as fs from "fs";
import * as path from "path";
import type { FileSystemPort } from "../../core/ports/filesystem";

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
}
