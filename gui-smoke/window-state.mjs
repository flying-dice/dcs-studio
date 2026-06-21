// GUI smoke for the window surface (issues #24 + #7). Drives the REAL built
// Tauri app through tauri-driver, spoken as raw W3C WebDriver over fetch (no
// webdriverio — tauri-driver sessions have no browserName, and raw HTTP keeps
// this dependency-free: just node + the tauri-driver binary). Run under a
// display (Xvfb in CI).
//
// WHAT THIS VERIFIES LIVE (the automatable contracts):
//   1. the harness — the real app boots under tauri-driver + a virtual display
//      (the reusable GUI gate this issue/#7 asked for);
//   2. a fresh profile (no state file) opens at the CONFIGURED DEFAULT geometry
//      — issue #24's "delete the state file → falls back to 1280×800" half,
//      now verified against the running window, not just tauri.conf.json;
//   3. the native window honours WebDriver geometry (a resize takes effect),
//      so the window is real and driveable.
//
// WHAT IT DELIBERATELY DOES NOT assert: the save-on-exit → restore-on-relaunch
// round-trip. tauri-plugin-window-state persists on a GRACEFUL exit
// (RunEvent::Exit); tauri-driver SIGKILLs the app on session teardown, so the
// save hook never runs (verified: no state file is written). That half stays
// covered by the headless config test (crates/app/tests/window_state.rs) — the
// restore fallback's input — and is a #7 follow-up once a graceful-quit path
// exists in the GUI harness.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const APP = process.env.TAURI_APP ?? "./target/debug/dcs-studio";
const PORT = Number(process.env.TAURI_DRIVER_PORT ?? 4444);
const BASE = `http://127.0.0.1:${PORT}`;
// tauri-plugin-window-state persists under the app config dir keyed by the
// bundle identifier; clearing it exercises the fresh-profile default path.
const STATE_DIR = join(homedir(), ".config", "com.jonat.dcs-studio");

function clearState() {
  if (!existsSync(STATE_DIR)) return;
  for (const f of readdirSync(STATE_DIR)) {
    if (f.toLowerCase().includes("state")) rmSync(join(STATE_DIR, f), { force: true });
  }
}

async function rpc(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok || json.value?.error) {
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json.value ?? json)}`);
  }
  return json.value;
}

const newSession = () =>
  rpc("POST", "/session", {
    capabilities: { alwaysMatch: { "tauri:options": { application: APP } } },
  }).then((v) => v.sessionId);
const getRect = (sid) => rpc("GET", `/session/${sid}/window/rect`);
const setRect = (sid, r) => rpc("POST", `/session/${sid}/window/rect`, r);
const endSession = (sid) => rpc("DELETE", `/session/${sid}`).catch(() => {});

const near = (a, target, slack = 60) => Math.abs(a - target) <= slack;

async function main() {
  const driver = spawn("tauri-driver", ["--port", String(PORT)], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  const fail = [];
  try {
    await sleep(2500); // let tauri-driver + the native WebDriver bind

    clearState();
    const sid = await newSession();
    await sleep(2000);

    // (2) fresh profile → the configured default geometry.
    const fresh = await getRect(sid);
    console.log("fresh launch rect:", JSON.stringify(fresh));
    if (!(near(fresh.width, 1280) && near(fresh.height, 800))) {
      fail.push(`fresh window not at the configured default 1280×800: got ${JSON.stringify(fresh)}`);
    }

    // (3) the native window honours a WebDriver resize.
    await setRect(sid, { x: fresh.x ?? 0, y: fresh.y ?? 0, width: 960, height: 640 });
    await sleep(800);
    const resized = await getRect(sid);
    console.log("after resize:", JSON.stringify(resized));
    if (!(near(resized.width, 960) && near(resized.height, 640))) {
      fail.push(`window did not resize via WebDriver: got ${JSON.stringify(resized)}, want ~960×640`);
    }

    await endSession(sid);
  } finally {
    driver.kill("SIGTERM");
  }

  if (fail.length) {
    console.error("window smoke FAILED:\n  " + fail.join("\n  "));
    process.exit(1);
  }
  console.log("window smoke OK: app launches under tauri-driver, opens at the default geometry, and is driveable");
}

main().catch((e) => {
  console.error("window smoke errored:", e);
  process.exit(1);
});
