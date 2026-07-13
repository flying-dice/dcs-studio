import * as os from "os";
import type { EnvPort } from "../../core/ports/env";

// Node adapter for `EnvPort` — process/OS environment probes used for DCS path
// resolution.
const DRIVES = ["C", "D", "E"];

export class NodeEnv implements EnvPort {
  homedir(): string {
    return os.homedir();
  }

  userProfile(): string | undefined {
    return process.env.USERPROFILE;
  }

  programFilesCandidates(): string[] {
    const out: string[] = [];
    for (const drive of DRIVES) {
      out.push(`${drive}:\\Program Files`, `${drive}:\\Program Files (x86)`);
    }
    return out;
  }
}
