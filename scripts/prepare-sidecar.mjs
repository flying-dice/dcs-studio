// Build the `lua-analyzer` language server and stage it as a Tauri sidecar so
// `tauri build` bundles it next to the app executable (the host resolves it
// via current_exe()'s sibling — crates/app/src/lsp.rs `lua_analyzer_path`).
//
// Tauri's `externalBin` looks for `<name>-<target-triple><ext>` next to the
// configured path (tauri.conf.json `bundle.externalBin`), and installs it as
// `<name><ext>` beside the main binary. We build in release and copy under
// the triple-suffixed name the bundler expects.

import { execSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const ext = isWin ? ".exe" : "";

// The host target triple (e.g. x86_64-pc-windows-msvc), parsed from rustc.
const triple = execSync("rustc -vV", { encoding: "utf8" })
  .split("\n")
  .find((line) => line.startsWith("host:"))
  ?.slice("host:".length)
  .trim();
if (!triple) {
  console.error("prepare-sidecar: could not determine host target triple from `rustc -vV`");
  process.exit(1);
}

console.log("prepare-sidecar: building lua-analyzer (release)…");
execSync("cargo build -p lua-analyzer --release", { cwd: root, stdio: "inherit" });

const src = join(root, "target", "release", `lua-analyzer${ext}`);
const destDir = join(root, "crates", "app", "binaries");
const dest = join(destDir, `lua-analyzer-${triple}${ext}`);

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`prepare-sidecar: staged ${dest}`);
