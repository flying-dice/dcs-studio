import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetVscode, state, vscodeMock } from "../support/vscode";

vi.mock("vscode", () => vscodeMock());
vi.mock("os", () => ({ platform: () => "win32", release: () => "10.0.22631" }));

import * as vscode from "vscode";
import { showError } from "../../../src/errors";
import { openExternal } from "../../../src/external";
import { mediaUri, renderWebviewHtml } from "../../../src/webview/html";

// Three pieces of shared adapter plumbing every panel routes through: the
// webview document scaffold (which is the extension's only XSS boundary — mod
// READMEs are rendered inside it), the error toast that carries Report Issue,
// and the guarded link opener those same READMEs post through.

const EXTENSION_ID = "flying-dice.dcs-studio";

function webview() {
  return state.panels.length
    ? state.panels[0].webview
    : (vscode.window.createWebviewPanel("t", "t", 1) as unknown as { webview: never }).webview;
}

function render(over: Partial<Parameters<typeof renderWebviewHtml>[0]> = {}): string {
  return renderWebviewHtml({
    webview: webview() as never,
    extensionUri: vscode.Uri.file("C:\\ext"),
    title: "A Panel",
    styles: ["panel.css"],
    scripts: ["panel.js"],
    ...over,
  });
}

beforeEach(() => {
  resetVscode({
    extensions: {
      [EXTENSION_ID]: {
        packageJSON: { version: "0.16.0", bugs: { url: "https://github.com/o/r/issues/" } },
      },
    },
  });
  vscode.window.createWebviewPanel("test", "test", 1);
});

describe("renderWebviewHtml", () => {
  it("locks the document down to nonce-tagged scripts only", () => {
    const html = render();
    const nonce = html.match(/nonce-([A-Za-z0-9]+)/)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(`script-src 'nonce-${nonce}'`);
    // Every script tag must carry the nonce, or the CSP silently blocks it.
    for (const tag of html.match(/<script[^>]*>/g) ?? []) {
      expect(tag).toContain(`nonce="${nonce}"`);
    }
  });

  it("issues a fresh nonce per render", () => {
    // A nonce reused across renders is no better than 'unsafe-inline'.
    const a = render().match(/nonce-([A-Za-z0-9]+)/)?.[1];
    const b = render().match(/nonce-([A-Za-z0-9]+)/)?.[1];
    expect(a).not.toBe(b);
  });

  it("loads the shared design system before the panel's own assets", () => {
    const html = render();
    // base.css defines the tokens panel.css overrides; shared.js defines the
    // dcsUi helpers panel.js calls at load.
    expect(html.indexOf("base.css")).toBeLessThan(html.indexOf("panel.css"));
    expect(html.indexOf("shared.js")).toBeLessThan(html.indexOf("panel.js"));
  });

  it("omits img-src and font-src unless the panel asks for them", () => {
    const html = render();
    expect(html).not.toContain("img-src");
    expect(html).not.toContain("font-src");
  });

  it("adds the requested img-src and font-src relaxations", () => {
    const html = render({ csp: { img: "https: data:", font: true } });
    expect(html).toContain("img-src vscode-webview://test https: data:");
    expect(html).toContain("font-src vscode-webview://test");
  });

  it("emits nonce-tagged inline scripts before the external ones", () => {
    const html = render({ inlineScripts: ["window.__BOOT__ = 1;"] });
    expect(html).toContain("window.__BOOT__ = 1;");
    expect(html.indexOf("window.__BOOT__")).toBeLessThan(html.indexOf("panel.js"));
  });

  it("emits the mobile viewport by default and drops it only on an explicit false", () => {
    // Every panel wants it; the sidebar view is the one caller that opts out.
    expect(render()).toContain('name="viewport"');
    expect(render({ viewport: true })).toContain('name="viewport"');
    expect(render({ viewport: false })).not.toContain('name="viewport"');
  });

  it("carries the title through to the document", () => {
    expect(render({ title: "DCS Marketplace" })).toContain("<title>DCS Marketplace</title>");
  });

  it("maps a media file to a webview-safe uri", () => {
    const uri = mediaUri(webview() as never, vscode.Uri.file("C:\\ext"), "icon.png");
    expect(uri.toString()).toContain("media/icon.png");
  });
});

describe("showError", () => {
  it("offers Report Issue alongside any caller-supplied actions", async () => {
    state.messageReplies.push(undefined);
    await showError("Something broke");
    expect(state.errors).toEqual(["Something broke"]);
  });

  it("returns the caller's own action when that is what the user picked", async () => {
    state.messageReplies.push("Retry");
    await expect(showError("Install failed", undefined, "Retry")).resolves.toBe("Retry");
    // Picking a caller action must not also open a browser tab.
    expect(state.openedExternal).toEqual([]);
  });

  it("opens a prefilled issue when Report Issue is chosen", async () => {
    state.messageReplies.push("Report Issue");
    await showError("Install failed", new Error("disk full"));

    const url = state.openedExternal[0];
    expect(url).toContain("https://github.com/o/r/issues/new?labels=bug");
    const body = decodeURIComponent(new URL(url).searchParams.get("body") ?? "");
    expect(body).toContain("Install failed");
    expect(body).toContain("disk full");
    expect(body).toContain("- DCS Studio: 0.16.0");
    expect(body).toContain("- VS Code: 1.125.0");
    expect(body).toContain("- OS: win32 10.0.22631");
  });

  it("passes the url as a string, not a Uri", async () => {
    // Uri.parse round-trips the query and corrupts the prefilled body
    // (microsoft/vscode#85930), so the target must stay a bare string.
    state.messageReplies.push("Report Issue");
    await showError("Boom");
    expect(typeof state.openedExternal[0]).toBe("string");
  });

  it("truncates a very long stack rather than producing an over-long url", async () => {
    state.messageReplies.push("Report Issue");
    const error = new Error("boom");
    error.stack = `Error: boom\n${"    at frame\n".repeat(500)}`;
    await showError("Boom", error);

    const body = decodeURIComponent(
      new URL(state.openedExternal[0]).searchParams.get("body") ?? "",
    );
    expect(body).toContain("… (truncated)");
    // GitHub rejects GET urls around 8k; the whole thing must stay under it.
    expect(state.openedExternal[0].length).toBeLessThan(8000);
  });

  it("truncates a very long message in the issue title", async () => {
    state.messageReplies.push("Report Issue");
    await showError("x".repeat(200));
    const title = decodeURIComponent(
      new URL(state.openedExternal[0]).searchParams.get("title") ?? "",
    );
    expect(title).toHaveLength(121);
    expect(title.endsWith("…")).toBe(true);
  });

  it("omits the stack section when there is no error", async () => {
    state.messageReplies.push("Report Issue");
    await showError("Just a message");
    const body = decodeURIComponent(
      new URL(state.openedExternal[0]).searchParams.get("body") ?? "",
    );
    expect(body).not.toContain("### Stack");
  });

  it("omits the stack section for a non-Error throwable", async () => {
    state.messageReplies.push("Report Issue");
    await showError("Odd failure", "just a string");
    const body = decodeURIComponent(
      new URL(state.openedExternal[0]).searchParams.get("body") ?? "",
    );
    expect(body).not.toContain("### Stack");
  });

  it("does nothing when the extension declares no bugs url", async () => {
    // Nothing to report to — better than opening a broken tab.
    resetVscode({ extensions: { [EXTENSION_ID]: { packageJSON: { version: "0.16.0" } } } });
    state.messageReplies.push("Report Issue");
    await expect(showError("Boom")).resolves.toBeUndefined();
    expect(state.openedExternal).toEqual([]);
  });

  it("accepts a bugs field given as a bare string", async () => {
    resetVscode({
      extensions: {
        [EXTENSION_ID]: { packageJSON: { bugs: "https://github.com/o/r/issues" } },
      },
    });
    state.messageReplies.push("Report Issue");
    await showError("Boom");
    expect(state.openedExternal[0]).toContain("https://github.com/o/r/issues/new");
  });

  it("reports an unknown version when the extension is not resolvable", async () => {
    resetVscode({});
    state.messageReplies.push("Report Issue");
    await showError("Boom");
    // No packageJSON at all: no bugs url, so nothing opens.
    expect(state.openedExternal).toEqual([]);
  });
});

describe("openExternal", () => {
  it("opens a link whose scheme the browser or mail client handles", () => {
    openExternal("https://github.com/owner/repo");
    openExternal("mailto:someone@example.com");
    expect(state.openedExternal).toEqual([
      "https://github.com/owner/repo",
      "mailto:someone@example.com",
    ]);
  });

  it("refuses any other scheme, loudly", () => {
    // A README rendered in the marketplace panel posts the url, so this is the
    // one place that stops `command:` reaching the editor. Refusing silently
    // would hide the attack — and our own bugs — equally well.
    openExternal('command:workbench.action.terminal.sendSequence?["evil"]');
    expect(state.openedExternal).toEqual([]);
    expect(state.errors).toEqual([
      'Refused to open a link that is not a web or mail address: command:workbench.action.terminal.sendSequence?["evil"]',
    ]);
  });
});
