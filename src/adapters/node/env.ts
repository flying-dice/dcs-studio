import * as os from "os";
import type { EnvPort } from "../../core/ports/env";

// Node adapter for `EnvPort` — process/OS environment probes used for DCS path
// resolution. Install roots are NOT here: they are pure string arithmetic with
// no environment in them, so they live in `core/domain/dcsDetect.ts`
// (`programFilesInstallRoots`), which is what `DetectService` actually calls.
export class NodeEnv implements EnvPort {
  homedir(): string {
    return os.homedir();
  }

  userProfile(): string | undefined {
    return process.env.USERPROFILE;
  }
}
