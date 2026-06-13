// Build the companion binaries and stage them as Tauri sidecars so
// `tauri build` bundles them next to the app executable:
//   - lua-analyzer    — the Lua language server the app spawns
//                       (crates/app/src/lsp.rs `lua_analyzer_path`)
//   - dcs-studio-cli  — the headless agent surface (MCP + init/check/build/…),
//                       shipped beside the app so agents need no separate build
//
// Tauri's `externalBin` looks for `<name>-<target-triple><ext>` next to the
// configured path (tauri.conf.json `bundle.externalBin`), and installs it as
// `<name><ext>` beside the main binary. We build in release and copy each
// under the triple-suffixed name the bundler expects.

import { execSync } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIDECARS = ["lua-analyzer", "dcs-studio-cli"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ext = process.platform === "win32" ? ".exe" : "";

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

console.log(`prepare-sidecar: building ${SIDECARS.join(", ")} (release)…`);
const pkgs = SIDECARS.map((name) => `-p ${name}`).join(" ");
execSync(`cargo build ${pkgs} --release`, { cwd: root, stdio: "inherit" });

const destDir = join(root, "crates", "app", "binaries");
mkdirSync(destDir, { recursive: true });
for (const name of SIDECARS) {
  const src = join(root, "target", "release", `${name}${ext}`);
  const dest = join(destDir, `${name}-${triple}${ext}`);
  copyFileSync(src, dest);
  console.log(`prepare-sidecar: staged ${dest}`);
}
