import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The contract between a panel's asset list and the preview page that stands in
// for it under Playwright.
//
// The e2e layer measures the PREVIEW pages, not the panels — so a script added
// to a panel and not to its preview is simply never executed, never measured,
// and the 100%-per-file gate still reports green. That is the one failure mode
// a coverage gate cannot catch by itself: it can only be as complete as the set
// of files it was pointed at.
//
// The reverse matters too, if less: a preview loading something the panel does
// not means the suite is exercising a page the product never renders.
//
// This is a static comparison of two file lists, so it belongs beside the other
// contribution-contract checks in the headless layer rather than in the browser.

const root = resolve(__dirname, "../../..");

/** `styles`/`scripts` as written in a panel's renderWebviewHtml call. */
function panelAssets(file: string): { styles: string[]; scripts: string[] } | undefined {
  const text = readFileSync(join(root, file), "utf8");
  const list = (key: "styles" | "scripts"): string[] | undefined => {
    const m = new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`).exec(text);
    if (!m) return undefined;
    return [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]);
  };
  const styles = list("styles");
  const scripts = list("scripts");
  return styles && scripts ? { styles, scripts } : undefined;
}

/** media/ assets a preview page links or loads, in document order. */
function previewAssets(file: string): { styles: string[]; scripts: string[] } {
  const html = readFileSync(join(root, "previews", file), "utf8");
  const grab = (re: RegExp): string[] =>
    [...html.matchAll(re)]
      .map((m) => m[1])
      .filter((href) => href.startsWith("../media/"))
      .map((href) => href.replace("../media/", ""));
  return {
    styles: grab(/<link[^>]+href="([^"]+)"/g),
    scripts: grab(/<script[^>]+src="([^"]+)"/g),
  };
}

/**
 * Every panel that renders a webview, paired with the preview standing in for
 * it. Derived from the preview directory rather than hand-listed, so a new
 * preview cannot quietly go unchecked.
 */
const PANEL_FOR_PREVIEW: Record<string, string> = {
  "console.html": "src/bridge/consolePanel.ts",
  "docs.html": "src/docs/docsPanel.ts",
  "log.html": "src/log/logPanel.ts",
  "manifest.html": "src/manifest/formPanel.ts",
  "marketplace.html": "src/marketplace/panel.ts",
  "mymods.html": "src/install/myModsPanel.ts",
  "nav.html": "src/nav/navView.ts",
  "newproject.html": "src/project/newProjectPanel.ts",
  "publish.html": "src/publish/publishPanel.ts",
  "setup.html": "src/setup/panel.ts",
  "skills.html": "src/skills/skillsPanel.ts",
};

// Assets renderWebviewHtml adds to every document, so a preview carries them
// without the panel naming them.
const ALWAYS_STYLES = ["base.css"];
const ALWAYS_SCRIPTS = ["shared.js"];

const previews = readdirSync(join(root, "previews")).filter((f) => f.endsWith(".html"));

describe("preview pages load exactly what their panel does", () => {
  it("has a panel mapped for every preview page", () => {
    // Guards the guard: an unmapped preview would be silently skipped below.
    expect(previews.sort()).toEqual(Object.keys(PANEL_FOR_PREVIEW).sort());
  });

  it.each(previews)("%s", (preview) => {
    const panel = panelAssets(PANEL_FOR_PREVIEW[preview]);
    expect(panel, `no styles/scripts found in ${PANEL_FOR_PREVIEW[preview]}`).toBeDefined();
    if (!panel) return;

    const page = previewAssets(preview);

    // Same assets, both directions. This is the drift that matters: a script on
    // the panel and not the preview is unmeasured by a gate still reporting
    // 100%, and one on the preview and not the panel means the suite is
    // exercising a page the product never renders.
    expect([...page.styles].sort()).toEqual([...ALWAYS_STYLES, ...panel.styles].sort());
    expect([...page.scripts].sort()).toEqual([...ALWAYS_SCRIPTS, ...panel.scripts].sort());

    // And the panel's own scripts in the panel's own order. These are plain
    // <script> tags with no module graph, so console.js reading DcsExplorerCore
    // depends on explorer-core.js having already run.
    //
    // Where `shared.js` sits is deliberately not asserted: renderWebviewHtml
    // always emits it first, but a preview may hoist a content script above it
    // so a fixture can substitute the data before the panel script snapshots it
    // (previews/docs.html does exactly that, and says why).
    expect(page.scripts.filter((s) => panel.scripts.includes(s))).toEqual(panel.scripts);
  });
});
