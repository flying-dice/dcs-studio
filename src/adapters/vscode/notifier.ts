import * as vscode from "vscode";
import type { NotifierPort } from "../../core/ports/notifier";
import { showError } from "../../errors";

// VS Code adapter for `NotifierPort`. Errors go through errors.ts showError so they
// carry the "Report Issue" affordance; info uses a plain information toast.
export class VsCodeNotifier implements NotifierPort {
  error(message: string, error?: unknown, ...actions: string[]): Promise<string | undefined> {
    return showError(message, error, ...actions);
  }

  info(message: string, ...actions: string[]): Promise<string | undefined> {
    return Promise.resolve(vscode.window.showInformationMessage(message, ...actions));
  }
}
