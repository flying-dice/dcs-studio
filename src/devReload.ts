import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

// Dev-only auto-reload: when running in an Extension Development Host, watch the
// built output (out/) and webview assets (media/) and reload the window shortly
// after they change. Paired with `tsc -watch`, editing a source file rebuilds
// out/ and the dev host reloads itself — "reload after each edit". Gated on
// ExtensionMode.Development, so an installed copy never does this.
export function setupDevReload(context: vscode.ExtensionContext): void {
  if (context.extensionMode !== vscode.ExtensionMode.Development) return;

  const dirs = ["out", "media", "package.json"].map((d) =>
    path.join(context.extensionUri.fsPath, d),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    // Debounce so a multi-file tsc rebuild triggers a single reload once it settles.
    timer = setTimeout(
      () => void vscode.commands.executeCommand("workbench.action.reloadWindow"),
      400,
    );
  };

  for (const target of dirs) {
    try {
      const stat = fs.statSync(target);
      const watcher = fs.watch(target, { recursive: stat.isDirectory() }, () => schedule());
      context.subscriptions.push(new vscode.Disposable(() => watcher.close()));
    } catch {
      // Missing dir/file (e.g. media absent) — skip it.
    }
  }
  void vscode.window.setStatusBarMessage("DCS Studio: dev auto-reload on out/ + media/", 4000);
}
