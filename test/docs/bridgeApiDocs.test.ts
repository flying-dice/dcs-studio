import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// The generator's core is pure and imported directly — no shelling out.
// @ts-expect-error — plain .mjs module, no type declarations.
import { BRIDGES, generateAll } from "../../scripts/generate-bridge-docs.mjs";

const root = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const readJson = (rel: string) => JSON.parse(read(rel));

// Normalize like the Rust golden tests do: the compare must not depend on the
// checkout's line-ending configuration.
const lf = (text: string) => text.replace(/\r\n/g, "\n");

describe("generated bridge API docs (golden)", () => {
  // The same anti-drift pattern as the Rust OpenRPC goldens: the checked-in
  // docs/bridge-api-*.md must be byte-for-byte what the generator emits from
  // the checked-in OpenRPC documents. On an intentional schema change,
  // regenerate with `npm run docs:bridge`.
  const pages: Map<string, string> = generateAll(readJson);

  it("documents both bridges", () => {
    expect([...pages.keys()].sort()).toEqual([
      "docs/bridge-api-gui.md",
      "docs/bridge-api-mission.md",
    ]);
  });

  for (const { json, out } of BRIDGES as { json: string; out: string }[]) {
    it(`${out} matches ${json}`, () => {
      const want = pages.get(out);
      expect(want, `generator emitted no page for ${out}`).toBeDefined();
      expect(lf(read(out)), `${out} drifted from ${json} — rerun \`npm run docs:bridge\``).toBe(
        lf(want as string),
      );
    });
  }
});
