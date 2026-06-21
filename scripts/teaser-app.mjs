// Launch the real Tauri app for the teaser recorder: `tauri dev` with WebView2
// remote debugging on :9222. The teaser starts on the landing page and CREATES a
// new project (the spec bypasses the native folder picker via the
// window.__dcsPickDir__ seam), so there is no DCS_OPEN here. Unlike
// scripts/e2e-app.mjs it does NOT redirect DCS_SAVED_GAMES — the teaser records
// against the developer's REAL DCS, so the REPL + DCS Log viewer show real data.
import { spawn } from "node:child_process";

process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222";

// --release: run the optimized release build (not the debug dev build), still
// served by vite on :1420 so the CDP attach + spec are unchanged.
const child = spawn("pnpm", ["tauri", "dev", "--release"], {
  stdio: "inherit",
  shell: true,
  env: process.env,
});

let killed = false;
function killTree() {
  if (killed || !child.pid) return;
  killed = true;
  // tauri dev is a process chain; on Windows a plain kill leaks the grandkids
  // (the app exe + WebView2) and they keep :9222 alive. Tree-kill by pid.
  try {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    child.kill();
  }
}
process.on("SIGTERM", () => (killTree(), process.exit(0)));
process.on("SIGINT", () => (killTree(), process.exit(0)));
process.on("exit", killTree);
child.on("exit", (code) => process.exit(code ?? 0));
