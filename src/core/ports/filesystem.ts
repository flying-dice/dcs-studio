// Port: filesystem access the core needs, expressed intent-first. The Node `fs`
// adapter implements this; no path/encoding/flag details leak into signatures.

export interface FileSystemPort {
  /** Read a file as UTF-8 text; rejects if it does not exist. */
  readText(path: string): Promise<string>;
  /** Write UTF-8 text, creating parent directories as needed. */
  writeText(path: string, contents: string): Promise<void>;
  /** Whether a path exists (file, dir, or link). */
  exists(path: string): Promise<boolean>;
  /** Whether a path exists and is a directory. */
  isDirectory(path: string): Promise<boolean>;
  /** Entry names directly under a directory. */
  readDir(path: string): Promise<string[]>;
  /** Remove a file or directory recursively; a no-op if absent. */
  remove(path: string): Promise<void>;
  /** Create a directory and any missing parents. */
  mkdirp(path: string): Promise<void>;
  /** Copy a single file from `src` to `dest`. */
  copy(src: string, dest: string): Promise<void>;
}
