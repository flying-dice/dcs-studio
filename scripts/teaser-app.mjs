// Launch the real Tauri app for the teaser recorder: `tauri dev` with WebView2
// remote debugging on :9222 + `DCS_OPEN` pointed at the teaser fixture project
// (the app's startup seam opens it without the native folder picker, which
// automation can't click). Unlike scripts/e2e-app.mjs it does NOT redirect
// DCS_SAVED_GAMES — the teaser records against the developer's REAL DCS, so the
// live REPL results and the DCS Log viewer show real data.
import { spawn } from "node:child_process";
import { resolve } from "node:path";

process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222";
process.env.DCS_OPEN ??= resolve("e2e/fixtures/teaser-mod");

const child = spawn("pnpm", ["tauri", "dev"], {
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
