import * as vscode from "vscode";

// Shared webview document scaffold. Every panel/view builds the same
// <!DOCTYPE>…<meta CSP nonce>…<script nonce> boilerplate and differs only in
// title, stylesheets, scripts and a couple of CSP knobs — this is the one place
// that boilerplate (and the nonce generator) lives. Each document also links
// the shared media/base.css (design system) before its own stylesheets and
// loads media/shared.js (the dcsUi helpers) before its own scripts.

/** A webview-safe URI for a file under the extension's media/ folder. */
export function mediaUri(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  file: string,
): vscode.Uri {
  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", file));
}

export interface RenderWebviewHtmlOptions {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  title: string;
  /** Per-panel stylesheets under media/, linked in order after base.css. */
  styles: string[];
  /** Per-panel scripts under media/, in order after shared.js. */
  scripts: string[];
  /** Optional CSP relaxations beyond the default-src/style-src/script-src base. */
  csp?: {
    /** Value appended after ${cspSource} on the img-src directive (e.g. "data:"). */
    img?: string;
    /** Add `font-src ${cspSource}`. */
    font?: boolean;
  };
  /** Inline <script> bodies (nonce-tagged) emitted before the external scripts. */
  inlineScripts?: string[];
  /** Emit the mobile viewport meta (true for every panel except the sidebar). */
  viewport?: boolean;
}

/** The complete webview HTML document (nonce + CSP baked in). */
export function renderWebviewHtml(opts: RenderWebviewHtmlOptions): string {
  const { webview, extensionUri, title } = opts;
  const nonce = getNonce();
  const media = (f: string) => mediaUri(webview, extensionUri, f);

  const csp = [
    `default-src 'none'`,
    ...(opts.csp?.img ? [`img-src ${webview.cspSource} ${opts.csp.img}`] : []),
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    ...(opts.csp?.font ? [`font-src ${webview.cspSource}`] : []),
  ].join("; ");

  const links = ["base.css", ...opts.styles]
    .map((f) => `  <link href="${media(f)}" rel="stylesheet" />`)
    .join("\n");
  const inline = (opts.inlineScripts ?? [])
    .map((s) => `  <script nonce="${nonce}">${s}</script>`)
    .join("\n");
  const scripts = ["shared.js", ...opts.scripts]
    .map((f) => `  <script nonce="${nonce}" src="${media(f)}"></script>`)
    .join("\n");
  const viewport =
    opts.viewport === false
      ? ""
      : `\n  <meta name="viewport" content="width=device-width, initial-scale=1.0" />`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />${viewport}
${links}
  <title>${title}</title>
</head>
<body>
  <div id="app"></div>
${[inline, scripts].filter(Boolean).join("\n")}
</body>
</html>`;
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
