// Ensure a live DCS with the bridge loaded before any test runs.
// If the bridge already answers /health we reuse the running instance and
// leave it alone afterwards; otherwise we launch DCS ourselves (the
// --no-launcher flag is required — without it DCS sits on the launcher UI
// forever) and global-teardown shuts it back down.

import { spawn } from "node:child_process";
import { bridgeHealthy, DCS_EXE } from "./dcs";

const BOOT_TIMEOUT_MS = 5 * 60_000;

export default async function globalSetup(): Promise<void> {
  if (await bridgeHealthy()) {
    console.log("DCS bridge already up — reusing the running instance.");
    return;
  }

  console.log(`Bridge not reachable — launching "${DCS_EXE}" --no-launcher …`);
  const child = spawn(DCS_EXE, ["--no-launcher"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  process.env.DCS_STARTED_BY_E2E = "1";

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await bridgeHealthy()) {
      console.log("DCS bridge is up.");
      return;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(
    `DCS bridge did not answer /health within ${BOOT_TIMEOUT_MS / 60_000} min — ` +
      "check Saved Games\\DCS.openbeta\\Logs\\dcs.log (DCS-STUDIO lines) and dcs_studio.log",
  );
}
