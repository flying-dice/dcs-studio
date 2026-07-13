// Port: Windows registry value queries (the adapter shells out to reg.exe). Used
// to discover DCS game installs from Eagle Dynamics keys.

export interface RegistryPort {
  /**
   * Query a registry subtree for every `valueName` value, returning
   * `[subkeyName, value]` pairs. Empty on any error or non-Windows host.
   */
  queryValues(hive: string, subKey: string, valueName: string): Promise<Array<[string, string]>>;
}
