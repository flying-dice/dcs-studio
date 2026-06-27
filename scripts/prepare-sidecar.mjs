// Build the companion binaries and stage them as Tauri sidecars so
// `tauri build` bundles them next to the app executable:
//   - lua-analyzer    — the Lua language server the app spawns
//                       (crates/app/src/lsp.rs `lua_analyzer_path`)
//
// (The MCP agent surface is hosted by the running app over loopback now, not a
// bundled dcs-studio-cli sidecar — issue #33.)
//
// Tauri's `externalBin` looks for `<name>-<target-triple><ext>` next to the
// configured path (tauri.conf.json `bundle.externalBin`), and installs it as
// `<name><ext>` beside the main binary. We build in release and copy each
// under the triple-suffixed name the bundler expects.
//
// We also build + stage the in-DCS runtime cdylib (crates/dcs-bridge →
// `dcs_studio.dll`, issue #70). Unlike the triple-suffixed externalBin
// executables, that DLL is a Tauri bundle *resource* (data the Injection
// Manager installs into DCS): staged under its bare name next to
// tauri.conf.json and referenced from `bundle.resources`, so the installer
// drops it next to the app exe — source_dll_path()'s first candidate
// (crates/studio-services/src/inject.rs). Without it an installed release
// cannot inject or launch DCS.

import { execSync } from "node:child_process";
import { mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIDECARS = ["lua-analyzer"];

// The in-DCS bridge cdylib package; on Windows it builds `dcs_studio.dll`.
// Building it needs DCS's Lua import lib (.cargo/config.toml LUA_LIB), so it
// only links on Windows — the only release target (bundle.targets: ["nsis"]).
const DLL_PACKAGE = "dcs-bridge";
const isWindows = process.platform === "win32";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ext = isWindows ? ".exe" : "";

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

// Off Windows the bridge cdylib can't link and is never shipped/loaded, so
// build it only on Windows; elsewhere a placeholder resource is staged below.
const buildPkgs = isWindows ? [...SIDECARS, DLL_PACKAGE] : [...SIDECARS];
console.log(`prepare-sidecar: building ${buildPkgs.join(", ")} (release)…`);
const pkgs = buildPkgs.map((name) => `-p ${name}`).join(" ");
execSync(`cargo build ${pkgs} --release`, { cwd: root, stdio: "inherit" });

const destDir = join(root, "crates", "app", "binaries");
mkdirSync(destDir, { recursive: true });
for (const name of SIDECARS) {
  const src = join(root, "target", "release", `${name}${ext}`);
  const dest = join(destDir, `${name}-${triple}${ext}`);
  copyFileSync(src, dest);
  console.log(`prepare-sidecar: staged ${dest}`);
}

// Stage the bridge runtime DLL next to tauri.conf.json as the `dcs_studio.dll`
// bundle resource (→ installed beside the app exe). tauri-build copies declared
// resources on every `cargo build` / `tauri dev`, all platforms, and fails if
// one is missing — so off Windows we stage an empty placeholder (the DLL is
// Windows-only and never loaded there).
const dllDest = join(root, "crates", "app", "dcs_studio.dll");
if (isWindows) {
  copyFileSync(join(root, "target", "release", "dcs_studio.dll"), dllDest);
  console.log(`prepare-sidecar: staged ${dllDest}`);
} else {
  writeFileSync(dllDest, "");
  console.log(`prepare-sidecar: staged placeholder ${dllDest} (DLL is Windows-only)`);
}
