// win32, not the host's flavour: this joins a Windows DCS install path, and the
// posix join produces the wrong thing off Windows.
import { win32 as path } from "node:path";
import type { InstallRootsPort } from "../ports/installRoots";

/** The file DCS reads to build the mission sandbox, under the install's Scripts. */
export const MISSION_FILE = "MissionScripting.lua";

/**
 * The MissionScripting.lua path for the configured install, or undefined when
 * no install path is set.
 *
 * Here rather than beside the panel that manages the file: the debug adapter
 * needs it too, to tell a user whether the sandbox is currently sanitized, and a
 * feature reaching into another feature to borrow a pure path rule is the
 * boundary violation this module exists on the right side of (#61). It is string
 * arithmetic over a port's answer — no I/O, nothing VS Code — so core is where
 * it belongs.
 */
export function missionScriptPath(roots: InstallRootsPort): string | undefined {
  const gameInstall = roots.gameInstall();
  return gameInstall ? path.join(gameInstall, "Scripts", MISSION_FILE) : undefined;
}

/**
 * Whether a path names the file that DEFINES the mission sandbox.
 *
 * Sending MissionScripting.lua into that sandbox to be evaluated re-runs the
 * sanitization the bridge lives inside — at best a no-op, at worst it tears
 * down the environment the session is talking to.
 *
 * The refusal has to be stated once because the session has four front doors,
 * and each was closed separately: the menu contributions' `when` clauses, the
 * Command Palette (a `when` clause is only a menu — the palette, a keybinding
 * and `executeCommand` all reach the handler directly), and F5 or a
 * hand-written `launch.json`, which reach the debug configuration provider
 * without passing the command handler at all.
 *
 * Split on both separators rather than using `path.basename`: an fsPath carries
 * Windows backslashes whatever the host's own separator is, and a `launch.json`
 * may spell either. `my-MissionScripting.lua` is somebody's own file and runs.
 */
export function isMissionScriptingFile(pathOrName: string): boolean {
  return pathOrName.toLowerCase().split(/[\\/]/).pop() === "missionscripting.lua";
}

/** What the user is told when they try it, wherever they tried it from. */
export const MISSION_SCRIPT_REFUSAL =
  "MissionScripting.lua defines the mission sandbox — it cannot be run or debugged in DCS. " +
  "Use “DCS Studio: Desanitize MissionScripting.lua” to edit what it allows.";
