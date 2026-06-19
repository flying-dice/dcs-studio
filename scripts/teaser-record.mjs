// One-command teaser recorder. Brings the real Tauri app up over CDP, then
// screen-captures the app window with ffmpeg while Playwright drives the
// dcs-studio speedrun (teaser/teaser.spec.ts) — Playwright can't video a
// CDP-attached WebView2 context. The app itself injects the bridge and LAUNCHES
// DCS during the take, so this needs no separate DCS setup. Output:
// teaser-results/teaser.mp4.
//
//   node scripts/teaser-record.mjs
//
// Records the SCREEN (the app window) — don't touch the machine during the run,
// and expect DCS to launch (windowed, low-spec) partway through.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const FFMPEG = process.env.FFMPEG ?? "ffmpeg"; // pass FFMPEG=<full path> if not on PATH
const WINDOW = process.env.TEASER_WINDOW ?? "dcs-studio"; // gdigrab window title; "desktop" = whole screen
const OUT = resolve("teaser-results");
mkdirSync(OUT, { recursive: true });
const VIDEO = resolve(OUT, "teaser.mp4");

function killApp(app) {
  try {
    if (app?.pid) spawn("taskkill", ["/pid", String(app.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* best effort */
  }
}

// 1) Bring the app up FIRST so ffmpeg never films the cargo build.
console.log("[teaser] launching the app (tauri dev + CDP) — the first build can take a few minutes...");
const app = spawn("node", ["scripts/teaser-app.mjs"], { stdio: "inherit", shell: true });
process.on("exit", () => killApp(app));

async function cdpReady() {
  try {
    const r = await fetch("http://localhost:9222/json/version", { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}
const deadline = Date.now() + 360_000;
while (!(await cdpReady())) {
  if (Date.now() > deadline) {
    console.error("[teaser] app CDP endpoint never came up — aborting.");
    killApp(app);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
await new Promise((r) => setTimeout(r, 3000)); // let the window paint

// 2) Capture the app window. Title capture keeps the frame to the IDE; set
//    TEASER_WINDOW=desktop to grab the whole screen instead.
const input = WINDOW === "desktop" ? "desktop" : `title=${WINDOW}`;
console.log(`[teaser] recording "${input}" -> ${VIDEO}`);
const ff = spawn(
  FFMPEG,
  ["-y", "-f", "gdigrab", "-framerate", "30", "-i", input, "-pix_fmt", "yuv420p", VIDEO],
  { stdio: ["pipe", "inherit", "inherit"] },
);
ff.on("error", (e) => console.error("[teaser] ffmpeg failed to start (PATH? pass FFMPEG=<path>):", e.message));

// 3) Drive the speedrun against the already-running app (reuseExistingServer).
await new Promise((r) => setTimeout(r, 1500));
const pw = spawnSync(
  "pnpm",
  ["exec", "playwright", "test", "--config", "playwright.teaser.config.ts"],
  { stdio: "inherit", shell: true },
);

// 4) Stop ffmpeg cleanly so the mp4 is finalised, then tear the app down.
try {
  ff.stdin.write("q");
} catch {
  ff.kill("SIGINT");
}
await new Promise((r) => ff.on("exit", r));
killApp(app);

console.log(`\n[teaser] ${pw.status === 0 ? "✓" : "⚠"} done — video: ${VIDEO}`);
console.log("[teaser] note: DCS may still be running (the app launched it) — close it when you're done.");
process.exit(pw.status ?? 0);
