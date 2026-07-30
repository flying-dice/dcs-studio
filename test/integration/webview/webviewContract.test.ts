import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { UNCOVERED_WEBVIEWS, WEBVIEW_PROTOCOLS } from "../../../src/core/app/webviewContract";

// The census half of the declared message contract
// (`src/core/app/webviewContract.ts`): which webviews it covers, and — the part
// that matters — which it does not.
//
// The contract was deliberately partial while card 14's rollout ran — only the
// webviews with a presenter had declared message unions — and it is now total.
// The uncovered list survives that, EMPTY, and the reason is the failure mode
// previewAssets.test.ts was written against: a gate is only as complete as the
// list it was given, and a webview nobody added to either list is invisible in
// exactly the same way whether it was an omission or a decision. So the two
// lists are still checked to be the exact complement of one another against the
// preview directory, which now means the covered set IS the directory. A twelfth
// webview arriving fails here until someone says which side of the line it is
// on — declaring it, or naming it as uncovered on purpose.
//
// A static comparison of file lists, so it sits in the headless layer beside
// the other contribution-contract checks rather than in the browser.

const root = resolve(__dirname, "../../..");

const previews = readdirSync(join(root, "previews"))
  .filter((f) => f.endsWith(".html"))
  .map((f) => f.replace(/\.html$/, ""));

/** media/ scripts a preview page loads, in document order. */
function previewScripts(page: string): string[] {
  const html = readFileSync(join(root, "previews", `${page}.html`), "utf8");
  return [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((src) => src.startsWith("../media/"))
    .map((src) => src.replace("../media/", ""));
}

// renderWebviewHtml adds this to every document; it belongs to no one panel's
// protocol, so it is not part of any declared `scripts` list.
const ALWAYS = "shared.js";

describe("the webview contract's census", () => {
  it("splits every preview page into covered or explicitly uncovered", () => {
    expect([...Object.keys(WEBVIEW_PROTOCOLS), ...UNCOVERED_WEBVIEWS].sort()).toEqual(
      [...previews].sort(),
    );
  });

  it("counts neither side twice", () => {
    // Belt and braces on the equality above: a name in both lists would still
    // satisfy it if another name went missing at the same time.
    for (const name of Object.keys(WEBVIEW_PROTOCOLS)) {
      expect(UNCOVERED_WEBVIEWS, name).not.toContain(name);
    }
    expect(new Set(UNCOVERED_WEBVIEWS).size).toBe(UNCOVERED_WEBVIEWS.length);
  });

  it.each(
    Object.entries(WEBVIEW_PROTOCOLS),
  )("%s names the preview page and scripts that actually implement it", (name, protocol) => {
    expect(protocol.preview).toBe(`${name}.html`);
    expect(previews).toContain(name);
    // The declared scripts are the webview half of the protocol — the files
    // the e2e drive measures. Comparing them to what the page really loads
    // stops the declaration naming a file that no longer exists, or missing
    // one that quietly took over part of the dispatch.
    expect(previewScripts(name).filter((s) => s !== ALWAYS)).toEqual([...protocol.scripts]);
  });
});
