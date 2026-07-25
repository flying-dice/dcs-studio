import * as vscode from "vscode";
import { isBrowsableUrl } from "./core/domain/externalUrl";
import { showError } from "./errors";

// The one place a webview-supplied link reaches the outside world.
//
// Four panels (marketplace, my mods, publish, docs) accept an `openExternal`
// message and every one of them used to forward the URL straight into
// `vscode.env.openExternal(vscode.Uri.parse(url))`. That is four copies of a
// decision that has to be made identically every time, and a fifth panel would
// have made it a fifth time — or forgotten to. The rule now lives in
// `core/domain/externalUrl.ts` and is applied here, so a panel cannot open a
// link without going past it.
//
// A refusal is deliberately loud. A URL that reaches this function with an
// unsupported scheme is either our own bug or a mod's README trying to steer
// the editor, and both are things the user (and an issue report) should see;
// dropping it silently would hide the attack and the bug equally well.

/**
 * Open a link the webview asked for, if it is one the browser or mail client
 * can handle. Anything else is refused with a visible error.
 */
export function openExternal(url: string): void {
  if (!isBrowsableUrl(url)) {
    void showError(`Refused to open a link that is not a web or mail address: ${url}`);
    return;
  }
  void vscode.env.openExternal(vscode.Uri.parse(url));
}
