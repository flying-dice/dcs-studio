import { execFile } from "child_process";
import { parseRegistryQuery } from "../../core/domain/dcsDetect";
import type { RegistryPort } from "../../core/ports/registry";

// Node adapter for `RegistryPort` — shells out to `reg.exe` and hands the raw
// stdout to the pure parser in core/domain/dcsDetect. Any error (non-Windows host,
// missing key, non-zero exit) yields an empty result.
export class RegExeRegistry implements RegistryPort {
  queryValues(hive: string, subKey: string, valueName: string): Promise<Array<[string, string]>> {
    return new Promise((resolve) => {
      execFile(
        "reg",
        ["query", `${hive}\\${subKey}`, "/s", "/v", valueName],
        { windowsHide: true },
        (err, stdout) => {
          if (err || !stdout) {
            resolve([]);
            return;
          }
          resolve(parseRegistryQuery(stdout, valueName));
        },
      );
    });
  }
}
