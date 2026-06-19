// One-command teaser recorder. Drives the real Tauri app over CDP through the
// dcs-studio speedrun (teaser/teaser.spec.ts) and screen-captures the app window
// with ffmpeg — Playwright cannot video a CDP-attached WebView2 context. Output:
// teaser-results/teaser.mp4.
//
//   node scripts/teaser-record.mjs
//
// PREREQ: a real DCS with the in-DCS bridge injected + RUNNING — the live REPL
// results and the DCS Log come from it. Inject via the IDE's Injection Manager
// (or `cargo run` the app and use it), then launch DCS. This script checks the
// bridge and warns (but still records) if it is down.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const FFMPEG = process.env.FFMPEG ?? "ffmpeg"; // on PATH after the winget install
const WINDOW = process.env.TEASER_WINDOW ?? "dcs-studio"; // gdigrab window title
const OUT = resolve("teaser-results");
mkdirSync(OUT, { recursive: true });
const VIDEO = resolve(OUT, "teaser.mp4");

// Warn (don't block) if the bridge isn't up — the live beats would be empty.
try {
  const res = await fetch("http://127.0.0.1:25569/health", {
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error();
  console.log("[teaser] ✓ DCS bridge is up — live REPL/log beats will be real.");
} catch {
  console.warn(
    "[teaser] ⚠ DCS bridge not reachable at :25569 — inject the bridge + launch DCS first, or the live beats will be empty.",
  );
}

// Capture the app window with ffmpeg (gdigrab). Title capture keeps the frame to
// the IDE; set TEASER_WINDOW=desktop to grab the whole screen instead.
const input = WINDOW === "desktop" ? "desktop" : `title=${WINDOW}`;
console.log(`[teaser] recording window "${input}" -> ${VIDEO}`);
const ff = spawn(
  FFMPEG,
  ["-y", "-f", "gdigrab", "-framerate", "30", "-i", input, "-pix_fmt", "yuv420p", VIDEO],
  { stdio: ["pipe", "inherit", "inherit"] },
);
ff.on("error", (e) => console.error("[teaser] ffmpeg failed to start:", e.message));

// Let ffmpeg attach, then run the Playwright drive (it launches the app via the
// teaser config's webServer + walks the speedrun).
await new Promise((r) => setTimeout(r, 1500));
const pw = spawnSync(
  "pnpm",
  ["exec", "playwright", "test", "--config", "playwright.teaser.config.ts"],
  { stdio: "inherit", shell: true },
);

// Stop ffmpeg cleanly so the mp4 is finalised ('q' on stdin > SIGINT for gdigrab).
try {
  ff.stdin.write("q");
} catch {
  ff.kill("SIGINT");
}
await new Promise((r) => ff.on("exit", r));

console.log(`\n[teaser] ${pw.status === 0 ? "✓" : "⚠"} done — video: ${VIDEO}`);
process.exit(pw.status ?? 0);
