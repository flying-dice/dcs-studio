import * as vscode from "vscode";
import * as os from "os";

// Every error popup in the extension goes through showError so it carries a
// "Report Issue" button that opens a pre-filled GitHub issue (message, stack,
// versions). The target repo comes from package.json's `bugs.url`.

const REPORT_ACTION = "Report Issue";
const EXTENSION_ID = "flying-dice.dcs-studio";
// GitHub caps GET URLs around 8k; keep the whole body comfortably under it.
const MAX_STACK_CHARS = 1500;

interface PackageMeta {
  version?: string;
  bugs?: { url?: string } | string;
}

function bugsUrl(): string | undefined {
  const pkg = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as PackageMeta | undefined;
  const bugs = pkg?.bugs;
  const url = typeof bugs === "string" ? bugs : bugs?.url;
  return url?.replace(/\/$/, "");
}

function issueBody(message: string, error: unknown): string {
  const pkg = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as PackageMeta | undefined;
  const lines = ["### What happened", "", message, ""];
  if (error instanceof Error && error.stack) {
    const stack =
      error.stack.length > MAX_STACK_CHARS
        ? `${error.stack.slice(0, MAX_STACK_CHARS)}\n… (truncated)`
        : error.stack;
    lines.push("### Stack", "", "```", stack, "```", "");
  }
  lines.push(
    "### Environment",
    "",
    `- DCS Studio: ${pkg?.version ?? "unknown"}`,
    `- VS Code: ${vscode.version}`,
    `- OS: ${os.platform()} ${os.release()}`,
    "",
    "### Anything else?",
    "",
    "<!-- Steps to reproduce, screenshots, logs… -->",
  );
  return lines.join("\n");
}

/**
 * Show an error notification with a "Report Issue" button. Pass the caught
 * error (if any) so its stack lands in the issue body. Extra `actions` are
 * shown before the report button; the chosen extra action is returned.
 */
export async function showError(
  message: string,
  error?: unknown,
  ...actions: string[]
): Promise<string | undefined> {
  const choice = await vscode.window.showErrorMessage(message, ...actions, REPORT_ACTION);
  if (choice === REPORT_ACTION) {
    const base = bugsUrl();
    if (!base) return undefined;
    const title = encodeURIComponent(message.length > 120 ? `${message.slice(0, 120)}…` : message);
    const body = encodeURIComponent(issueBody(message, error));
    const url = `${base}/new?labels=bug&title=${title}&body=${body}`;
    // Deliberately a string, not Uri.parse(url): the Uri round-trip re-encodes
    // the query and corrupts the prefilled body (microsoft/vscode#85930).
    // openExternal passes string targets through to the browser verbatim.
    void vscode.env.openExternal(url as unknown as vscode.Uri);
    return undefined;
  }
  return choice;
}
