import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// The containment rule as data, loaded once for the two TypeScript suites that
// check a copy of it (src/core/domain/pathContainment.ts and the webview's copy
// in media/manifest-core.js). The bridge's third copy reads the same file at
// compile time through include_str!, which is the point: adding a case here
// fails all three until every copy agrees.

export interface ContainmentCase {
  path: string;
  /** Why the case is in the table — reported when an assertion fails. */
  why: string;
}

/**
 * A manifest `dest` and the relative path it reduces to once its root token is
 * stripped. The verdict is deliberately not stated: it follows from running
 * `relative` through the containment rule above, so a case cannot claim one
 * thing about the token and another about the path under it.
 */
export interface DestCase {
  dest: string;
  relative: string;
  why: string;
}

export const CONTAINMENT_CASES: {
  accept: ContainmentCase[];
  reject: ContainmentCase[];
  dest: DestCase[];
} = JSON.parse(
  readFileSync(join(resolve(__dirname, "../.."), "spec", "path-containment.cases.json"), "utf8"),
);

/** Every case, verdict discarded — for a copy checked against the domain one. */
export const ALL_CONTAINMENT_PATHS: string[] = [
  ...CONTAINMENT_CASES.accept,
  ...CONTAINMENT_CASES.reject,
].map((c) => c.path);
