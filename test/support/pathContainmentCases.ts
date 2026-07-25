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

export const CONTAINMENT_CASES: { accept: ContainmentCase[]; reject: ContainmentCase[] } =
  JSON.parse(
    readFileSync(join(resolve(__dirname, "../.."), "spec", "path-containment.cases.json"), "utf8"),
  );

/** Every case, verdict discarded — for a copy checked against the domain one. */
export const ALL_CONTAINMENT_PATHS: string[] = [
  ...CONTAINMENT_CASES.accept,
  ...CONTAINMENT_CASES.reject,
].map((c) => c.path);
