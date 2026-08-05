// Port: filesystem access the core needs, expressed intent-first. The Node `fs`
// adapter implements this; no path/encoding/flag details leak into signatures.

/** What is at a path, and how much of it. */
export interface PathMeasure {
  /**
   * Whether the path is a directory — a `[[bundle]]` entry that brings a whole
   * tree rather than one file.
   *
   * Not inferable from `files`: a folder holding a single file and that file
   * itself both measure one, and the archive preview says something different
   * about each.
   */
  directory: boolean;
  /** Files, counting only leaves — a directory is never one of them. */
  files: number;
  bytes: number;
}

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
  /**
   * What is at `path` — one file, a directory with its recursive totals, or
   * `null` when nothing is there.
   *
   * Absence is a RETURN VALUE rather than a rejection, and the two questions are
   * one call rather than an `exists` followed by a sizing, because the caller is
   * the manifest form's archive preview: it asks about paths a build step has
   * not produced yet, so "not there" is the ordinary answer, not a fault. Two
   * calls could also straddle a build finishing and report a path as present
   * with nothing in it.
   */
  measure(path: string): Promise<PathMeasure | null>;
  /** Remove a file or directory recursively; a no-op if absent. */
  remove(path: string): Promise<void>;
  /** Create a directory and any missing parents. */
  mkdirp(path: string): Promise<void>;
  /** Copy a single file from `src` to `dest`. */
  copy(src: string, dest: string): Promise<void>;
  /**
   * Move a file or directory to `dest`, which must not already exist. Same
   * volume only — this is the "swap a staged directory into place" primitive,
   * not a general relocation, so it stays a rename and never a deep copy.
   */
  move(src: string, dest: string): Promise<void>;
}
