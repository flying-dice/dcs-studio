import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawn } from "child_process";
import { showError } from "../errors";

// Build the bridge workspace (bridge/) into dcs_studio_gui.dll +
// dcs_studio_mission.dll (one `cargo build --release` produces both).
// Requires the user's Rust toolchain + MSVC. The extension ships prebuilt
// DLLs too, so this is only needed when the bridge source is changed.
export async function buildBridge(ctx: vscode.ExtensionContext): Promise<void> {
  const bridgeDir = path.join(ctx.extensionUri.fsPath, "bridge");
  if (!fs.existsSync(path.join(bridgeDir, "Cargo.toml"))) {
    void showError("Bridge source (bridge/) is not present in this build.");
    return;
  }
  const out = vscode.window.createOutputChannel("DCS Studio Bridge Build");
  out.show(true);
  out.appendLine(`$ cargo build --release   (cwd: ${bridgeDir})`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Building DCS bridge (cargo build --release)…",
      cancellable: false,
    },
    () =>
      new Promise<void>((resolve) => {
        const proc = spawn("cargo", ["build", "--release"], { cwd: bridgeDir, shell: true });
        proc.stdout.on("data", (d) => out.append(d.toString()));
        proc.stderr.on("data", (d) => out.append(d.toString()));
        proc.on("error", (e) => {
          out.appendLine(`\nFailed to start cargo: ${e.message}`);
          void showError("Could not run cargo. Is the Rust toolchain installed and on PATH?", e);
          resolve();
        });
        proc.on("exit", (code) => {
          out.appendLine(`\ncargo exited with code ${code}`);
          if (code === 0) {
            void vscode.window.showInformationMessage(
              "Bridge built (dcs_studio_gui.dll + dcs_studio_mission.dll). Run DCS Studio: Inject, or Launch DCS, to use them.",
            );
          } else {
            void showError("Bridge build failed — see the 'DCS Studio Bridge Build' output.");
          }
          resolve();
        });
      }),
  );
}
