// Launch the real Tauri app for the e2e-lang CDP suite.
//
// `tauri dev` builds + runs the packaged app (vite at :1420, the Rust shell,
// and the spawned lua-analyzer backend) — the exact stack the IDE ships. We
// flip on WebView2 remote debugging so Playwright can attach over the Chrome
// DevTools Protocol (the only e2e transport that works against WebView2 on
// Windows; the plugin's unix-socket bridge does not). Playwright's webServer
// owns this process's lifecycle: it waits on the CDP endpoint, then kills us.
//
// CRITICAL: `pnpm tauri dev` is a chain (pnpm → cargo → the app exe → a
// WebView2 host), and on Windows killing this launcher does NOT cascade to
// those grandchildren. A leaked app keeps :9222 alive, so the NEXT run's
// `reuseExistingServer` attaches to a stale instance and every spec times out.
// So we tree-kill by pid (`taskkill /T /F`) on every exit path.
import { spawn, spawnSync } from "node:child_process";

process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222";

// Build the hosted engine first. `tauri dev` rebuilds the app crate but NOT
// the standalone `lua-analyzer` binary it spawns, so without this the suite
// would run against a stale analyzer (the `pretauri:dev` npm hook that does
// this is bypassed when the tauri CLI is invoked directly).
const build = spawnSync("cargo", ["build", "-p", "lua-analyzer"], {
  stdio: "inherit",
  shell: true,
});
if (build.status !== 0) process.exit(build.status ?? 1);

const child = spawn("pnpm", ["tauri", "dev"], {
  stdio: "inherit",
  shell: true,
  env: process.env,
});

let killed = false;
function killTree() {
  if (killed || !child.pid) return;
  killed = true;
  try {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } catch {
    child.kill();
  }
}

process.on("SIGTERM", () => {
  killTree();
  process.exit(0);
});
process.on("SIGINT", () => {
  killTree();
  process.exit(0);
});
process.on("exit", killTree);
child.on("exit", (code) => process.exit(code ?? 0));
