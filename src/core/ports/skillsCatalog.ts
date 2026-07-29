import type { SkillInfo } from "../domain/skillsStatus";
import type { BridgeSubscription } from "./debugBridge";

// Port: the agent-skill catalogue, as anything showing its state consumes it.
//
// The sidebar wanted two things from `SkillsLibrary` — tell me when the set
// changed, and how many are out of date — and named the concrete class to get
// them (#61). Both were type-only imports, so the coupling only ever cost the
// ability to render the nav against anything but a live filesystem watcher.
//
// Not the whole library: installing, listing and reading frontmatter belong to
// the panel that manages skills, and putting them here would make every future
// consumer of "how many updates are there" carry them.

export interface SkillsCatalogPort {
  /**
   * Fires when the installed set changes — a workspace folder opening, or the
   * watcher seeing a skill file written.
   */
  onDidChange(listener: () => void): BridgeSubscription;
  /** Installed skills with a newer bundled version, for the nav's badge. */
  updatesAvailable(): Promise<SkillInfo[]>;
}
