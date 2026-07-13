import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { showError } from "../errors";
import { MYMODS_URI_PATH, myModsUri, buildIco } from "../core/domain/shortcut";

// Desktop / Start Menu shortcuts that launch straight into My Mods. The .lnk
// targets the VS Code executable with `--new-window --open-url <deep link>`:
// a fresh window opens (no project) and the URI handler in extension.ts routes
// it to the panel. Windows-only, like DCS itself. The pure pieces — the deep-link
// URI and the PNG-in-ICO byte assembly — live in core/domain/shortcut.ts; this
// module owns the PowerShell + filesystem glue.

export { MYMODS_URI_PATH };

/** The vscode:// deep link that opens My Mods (scheme varies per product, e.g. insiders). */
export function myModsDeepLink(context: vscode.ExtensionContext): string {
  return myModsUri(vscode.env.uriScheme, context.extension.id);
}

export async function createMyModsShortcut(context: vscode.ExtensionContext): Promise<void> {
  if (process.platform !== "win32" || vscode.env.remoteName) {
    void showError("My Mods shortcuts are only supported on a local Windows install.");
    return;
  }

  const picked = await vscode.window.showQuickPick(
    [
      { label: "Desktop", picked: true, folder: "Desktop" as const },
      { label: "Start Menu", picked: true, folder: "Programs" as const },
    ],
    {
      canPickMany: true,
      title: "Add a My Mods shortcut",
      placeHolder: "Where should the shortcut go? It opens My Mods in its own window — no project involved.",
    },
  );
  if (!picked?.length) return;

  const icon = ensureIcon(context);
  const failures: string[] = [];
  for (const p of picked) {
    const r = await writeLnk(p.folder, context, icon);
    if (!r.ok) failures.push(`${p.label}: ${r.message}`);
  }
  if (failures.length) {
    void showError(`Couldn't create the shortcut — ${failures.join("; ")}`);
  } else {
    void vscode.window.showInformationMessage(
      `Shortcut added to ${picked.map((p) => p.label).join(" and ")}. It opens My Mods in its own window.`,
    );
  }
}

/** Write "DCS Studio - My Mods.lnk" into a Windows special folder via WScript.Shell. */
function writeLnk(
  specialFolder: "Desktop" | "Programs",
  context: vscode.ExtensionContext,
  icon: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const exe = process.execPath; // the Code.exe hosting this window
  // Mirrors how VS Code registers the vscode:// protocol handler itself.
  const args = `--new-window --open-url -- ${myModsDeepLink(context)}`;
  const script = [
    `$ErrorActionPreference='Stop'`,
    `$dir = [Environment]::GetFolderPath(${psq(specialFolder)})`,
    `$ws = New-Object -ComObject WScript.Shell`,
    `$s = $ws.CreateShortcut((Join-Path $dir 'DCS Studio - My Mods.lnk'))`,
    `$s.TargetPath = ${psq(exe)}`,
    `$s.Arguments = ${psq(args)}`,
    `$s.WorkingDirectory = ${psq(path.dirname(exe))}`,
    `$s.IconLocation = ${psq(`${icon},0`)}`,
    `$s.Description = 'Enable, update & remove your installed DCS mods'`,
    `$s.Save()`,
  ].join("; ");
  return new Promise((resolve) => {
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
    });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", (e) => resolve({ ok: false, message: e.message }));
    p.on("exit", (c) => (c === 0 ? resolve({ ok: true }) : resolve({ ok: false, message: err.trim() || `exit ${c}` })));
  });
}

/**
 * The .lnk icon: .lnk files can't use a PNG, so wrap the bundled 256×256
 * media/icon.png in an ICO container (PNG-in-ICO, supported since Vista) and
 * park it in global storage where it survives extension updates in place.
 */
function ensureIcon(context: vscode.ExtensionContext): string {
  const dir = context.globalStorageUri.fsPath;
  fs.mkdirSync(dir, { recursive: true });
  const ico = path.join(dir, "dcs-studio.ico");
  const png = fs.readFileSync(path.join(context.extensionPath, "media", "icon.png"));
  fs.writeFileSync(ico, buildIco(png));
  return ico;
}

function psq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
