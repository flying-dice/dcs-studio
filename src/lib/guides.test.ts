import { describe, it, expect } from "vitest";
import {
  GUIDE_GROUPS,
  GUIDES,
  FIRST_GUIDE_KEY,
  DISCOVERED_KEYS,
  guideByKey,
} from "./guides";

// The issue #72 checklist, encoded. This is the contract the viewer ships
// against: every group present, in order, with every listed guide. A missing
// content file fails earlier still — the manifest throws on import — but pinning
// the full set here keeps "complete coverage of the chosen groups" honest at the
// CI-gated unit layer (renderMarkdown needs a DOM, so it is exercised by the
// e2e/GUI smoke, not here).
const EXPECTED = [
  {
    id: "getting-started",
    label: "Getting started",
    slugs: ["projects-and-templates", "workspace-tour", "run-configurations"],
  },
  {
    id: "dcs-integration",
    label: "DCS integration",
    slugs: [
      "injecting-the-bridge",
      "managed-launch-dcs",
      "lua-console",
      "sync-types-from-dcs",
      "mission-scripting-sanitization",
      "in-sim-lua-debugger",
      "database-browser",
      "dcs-log-viewer",
      "inspect-console",
    ],
  },
  {
    id: "editing-and-language",
    label: "Editing & language",
    slugs: [
      "editor-basics-and-tabs",
      "formatting-and-format-on-save",
      "refactoring",
      "bookmarks",
      "structure-and-outline",
      "language-intelligence",
      "search",
    ],
  },
  {
    id: "distribution-and-tooling",
    label: "Distribution & tooling",
    slugs: [
      "build",
      "dependencies",
      "packages",
      "publish-and-share",
      "marketplace",
      "installer",
      "terminal",
      "todos",
      "recipes",
      "notifications",
      "github-sign-in",
      "mcp-server",
    ],
  },
];

const TOTAL = EXPECTED.reduce((n, g) => n + g.slugs.length, 0);

describe("guides manifest", () => {
  it("has the four groups in checklist order with their labels", () => {
    expect(GUIDE_GROUPS.map((g) => g.id)).toEqual(EXPECTED.map((g) => g.id));
    expect(GUIDE_GROUPS.map((g) => g.label)).toEqual(
      EXPECTED.map((g) => g.label),
    );
  });

  it("ships every checklist guide, in order, under its group", () => {
    for (const want of EXPECTED) {
      const group = GUIDE_GROUPS.find((g) => g.id === want.id);
      expect(group, want.id).toBeDefined();
      expect(group!.guides.map((g) => g.slug)).toEqual(want.slugs);
    }
  });

  it("covers exactly the checklist — no orphaned or missing files", () => {
    const manifestKeys = EXPECTED.flatMap((g) =>
      g.slugs.map((s) => `${g.id}/${s}`),
    ).sort();
    expect([...DISCOVERED_KEYS].sort()).toEqual(manifestKeys);
    expect(GUIDES).toHaveLength(TOTAL);
  });

  it("gives every guide a stable key, an H1 title, and a non-empty body", () => {
    const seen = new Set<string>();
    for (const guide of GUIDES) {
      expect(guide.key).toBe(`${guide.groupId}/${guide.slug}`);
      expect(seen.has(guide.key), `duplicate key ${guide.key}`).toBe(false);
      seen.add(guide.key);

      // Title is the Markdown H1 — the index label and the rendered heading are
      // the same string, so a guide with no H1 (title would fall back to slug)
      // is a content defect.
      const h1 = guide.body.match(/^#\s+(.+?)\s*$/m);
      expect(h1, `${guide.key} has no H1`).not.toBeNull();
      expect(guide.title).toBe(h1![1]);
      expect(guide.body.trim().length).toBeGreaterThan(0);
    }
  });

  it("opens on the first guide and resolves keys", () => {
    expect(FIRST_GUIDE_KEY).toBe("getting-started/projects-and-templates");
    expect(guideByKey(FIRST_GUIDE_KEY)).toBe(GUIDES[0]);
    expect(guideByKey("nope/missing")).toBeUndefined();
  });
});
