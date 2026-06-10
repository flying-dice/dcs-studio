// Shut DCS down only if global-setup launched it; a pre-existing instance
// (e.g. one the developer is using) is left running.

import { bridgeHealthy, rpcNotify } from "./dcs";

export default async function globalTeardown(): Promise<void> {
  if (process.env.DCS_STARTED_BY_E2E !== "1") return;
  if (!(await bridgeHealthy())) return;

  console.log("Shutting down the DCS instance started by the e2e suite …");
  try {
    await rpcNotify("eval", { code: "DCS.exitProcess()" });
  } catch {
    // Notification responses are fire-and-forget; DCS dying mid-request is fine.
  }
}
