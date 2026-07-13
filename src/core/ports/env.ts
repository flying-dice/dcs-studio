// Port: process/OS environment probes the core needs for path resolution. The
// Node adapter reads `os` + `process.env`.

export interface EnvPort {
  /** The current user's home directory. */
  homedir(): string;
  /** `%USERPROFILE%`, or undefined when unset. */
  userProfile(): string | undefined;
  /** Program Files roots to probe for installs (per candidate drive). */
  programFilesCandidates(): string[];
}
