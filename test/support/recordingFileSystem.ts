import type { FileSystemPort, PathMeasure } from "../../src/core/ports/filesystem";

// A `FileSystemPort` decorator: records every call and can be told to reject a
// specific one. It is deliberately not a second implementation — the semantics
// stay in `MemFileSystem`, which is the one thing held to the port contract, so
// a test that needs a call log or a scripted EACCES cannot quietly drift away
// from what the real adapter does.

export type FsMethod = keyof FileSystemPort;

/** A recorded call: the method name followed by the arguments it was given. */
export type FsCall = [FsMethod, ...string[]];

export class RecordingFileSystem implements FileSystemPort {
  readonly calls: FsCall[] = [];
  private readonly failures: {
    method: FsMethod;
    path?: string;
    message: string;
    skip: number;
  }[] = [];

  constructor(private readonly inner: FileSystemPort) {}

  /**
   * Make `method` reject with `message`; `path` narrows it to one target.
   *
   * `skip` lets the first N matching calls through before failing, for the case
   * where one path is touched more than once in a single operation and only the
   * later touch is under test — the install swap removes `<dir>.previous` both
   * before it starts (clearing a leftover) and after it succeeds (cleanup), and
   * those two are different moments with different correct behaviours.
   */
  failOn(method: FsMethod, message: string, path?: string, skip = 0): void {
    this.failures.push({ method, path, message, skip });
  }

  /** The arguments of each recorded call to `method`, in order. */
  argsFor(method: FsMethod): string[][] {
    return this.calls.filter((c) => c[0] === method).map((c) => c.slice(1) as string[]);
  }

  /** The first argument — the path — of each recorded call to `method`. */
  pathsFor(method: FsMethod): string[] {
    return this.argsFor(method).map((args) => args[0]);
  }

  async readText(p: string): Promise<string> {
    return this.run("readText", [p], () => this.inner.readText(p));
  }

  async writeText(p: string, contents: string): Promise<void> {
    return this.run("writeText", [p, contents], () => this.inner.writeText(p, contents));
  }

  async exists(p: string): Promise<boolean> {
    return this.run("exists", [p], () => this.inner.exists(p));
  }

  async isDirectory(p: string): Promise<boolean> {
    return this.run("isDirectory", [p], () => this.inner.isDirectory(p));
  }

  async readDir(p: string): Promise<string[]> {
    return this.run("readDir", [p], () => this.inner.readDir(p));
  }

  async measure(p: string): Promise<PathMeasure | null> {
    return this.run("measure", [p], () => this.inner.measure(p));
  }

  async remove(p: string): Promise<void> {
    return this.run("remove", [p], () => this.inner.remove(p));
  }

  async mkdirp(p: string): Promise<void> {
    return this.run("mkdirp", [p], () => this.inner.mkdirp(p));
  }

  async copy(src: string, dest: string): Promise<void> {
    return this.run("copy", [src, dest], () => this.inner.copy(src, dest));
  }

  async move(src: string, dest: string): Promise<void> {
    return this.run("move", [src, dest], () => this.inner.move(src, dest));
  }

  private async run<T>(method: FsMethod, args: string[], call: () => Promise<T>): Promise<T> {
    this.calls.push([method, ...args]);
    const failure = this.failures.find(
      (f) => f.method === method && (f.path === undefined || f.path === args[0]),
    );
    if (failure) {
      if (failure.skip > 0) failure.skip--;
      else throw new Error(failure.message);
    }
    return await call();
  }
}
