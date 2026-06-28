// Vendored, in-repo guide content for Help → Guides (issue #72). Every guide is
// bundled at build time via `import.meta.glob` (eager + `?raw`), so the whole
// series ships inside the app and renders with NO network — the offline
// requirement. The reading pane feeds each body through the same
// `renderMarkdown` (marked + DOMPurify) the Marketplace README uses, so authors
// write plain CommonMark/GFM.
//
// The index order shown in the viewer is the order of `MANIFEST` below; it
// mirrors the four checklist groups on the issue. A guide's title is NOT
// repeated here — it is the Markdown H1 of its file (`titleOf`), so the index
// label and the rendered heading can never drift out of sync.

const RAW = import.meta.glob("./**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export type Guide = {
  /** Stable identity within the viewer: `${groupId}/${slug}`. */
  key: string;
  groupId: string;
  slug: string;
  /** The guide's H1 — drives the index label and the in-pane heading. */
  title: string;
  /** Raw Markdown, rendered by `renderMarkdown` in the reading pane. */
  body: string;
};

export type GuideGroup = {
  id: string;
  label: string;
  guides: Guide[];
};

// group id (== directory name) → display label → ordered slugs (== file stems).
const MANIFEST: { id: string; label: string; slugs: string[] }[] = [
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

const pathOf = (groupId: string, slug: string) => `./${groupId}/${slug}.md`;

function bodyFor(groupId: string, slug: string): string {
  const body = RAW[pathOf(groupId, slug)];
  // Fail loud: a manifest entry with no file is a build error, not a silent
  // gap in the series. The unit test and `vite build` both surface this.
  if (body === undefined) {
    throw new Error(`guides: no content file for ${groupId}/${slug}`);
  }
  return body;
}

const H1 = /^#\s+(.+?)\s*$/m;

function titleOf(body: string, slug: string): string {
  return body.match(H1)?.[1] ?? slug;
}

export const GUIDE_GROUPS: GuideGroup[] = MANIFEST.map((group) => ({
  id: group.id,
  label: group.label,
  guides: group.slugs.map((slug) => {
    const body = bodyFor(group.id, slug);
    return {
      key: `${group.id}/${slug}`,
      groupId: group.id,
      slug,
      title: titleOf(body, slug),
      body,
    };
  }),
}));

/** Flat, index-ordered list — the viewer's selection model. */
export const GUIDES: Guide[] = GUIDE_GROUPS.flatMap((g) => g.guides);

/** Lookup by `${groupId}/${slug}`. */
const BY_KEY = new Map(GUIDES.map((g) => [g.key, g]));

export const guideByKey = (key: string): Guide | undefined => BY_KEY.get(key);

/** The guide the viewer opens on first show. */
export const FIRST_GUIDE_KEY = GUIDES[0]?.key ?? "";

/**
 * Every Markdown file the glob found, as `${groupId}/${slug}` keys. The unit
 * test diffs this against the manifest to catch an orphaned file (shipped but
 * unlisted) or a manifest entry whose file is missing.
 */
export const DISCOVERED_KEYS: string[] = Object.keys(RAW).map((p) =>
  p.replace(/^\.\//, "").replace(/\.md$/, ""),
);
