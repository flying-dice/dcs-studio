// Thin wrappers over the Rust filesystem commands + the folder-picker dialog.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { wsCall } from "./dcs-ws";

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export function readDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("read_dir", { path });
}

export function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

/**
 * A file read for the editor, classified by content (model studio::files
 * FileLoad / Rust `FileLoad`): a tagged union — `text` carries the decoded
 * contents, `binary` carries only the byte size (the bytes stay on disk).
 */
export type FileLoad =
  | { kind: "text"; text: string }
  | { kind: "binary"; size: number };

/**
 * Read a file, classifying it by CONTENT not extension: a NUL byte in the
 * leading chunk, or any non-UTF-8 byte, means binary (size only); otherwise the
 * decoded text. Replaces `readTextFile` on the editor's open path —
 * `readTextFile` stays for saves and strict-UTF-8 callers.
 */
export function classifyAndRead(path: string): Promise<FileLoad> {
  return invoke<FileLoad>("read_file", { path });
}

export function writeTextFile(path: string, contents: string): Promise<void> {
  return invoke<void>("write_text_file", { path, contents });
}

/** A formatting outcome (model `fmt::Formatted`). */
export interface FormatResult {
  /** The formatted source, or the input unchanged when `guard_tripped`. */
  text: string;
  /**
   * The formatter's semantic guard rejected the printed text and `text` is
   * the input unchanged — a formatter bug. The editor warns and keeps the
   * buffer as-is; it never aborts the action.
   */
  guard_tripped: boolean;
}

/**
 * Format Lua `text` belonging to the file at `path` through the same engine
 * the CLI `fmt` runs (its enclosing dcs-studio.toml `[format]` governs style).
 * `range` (`[start, end)` byte offsets) formats only the statements enclosing
 * the selection; omit it to format the whole document. Rejects when the
 * buffer does not parse — the caller keeps the original text.
 */
export function formatSource(
  path: string,
  text: string,
  range: [number, number] | null,
): Promise<FormatResult> {
  return invoke<FormatResult>("format_source", { path, text, range });
}

export function basename(path: string): Promise<string> {
  return invoke<string>("basename", { path });
}

/** Whether a path still exists on disk (used to flag stale recent projects). */
export function pathExists(path: string): Promise<boolean> {
  return invoke<boolean>("path_exists", { path });
}

/**
 * Scaffold a new project at `<parent>/<name>` from a named template
 * (`blank`, `lua-script`, `rust-dll`) via the shared project kit.
 * Returns the absolute path of the new project root.
 */
export function createProjectFromTemplate(
  parent: string,
  name: string,
  template: string,
): Promise<string> {
  return invoke<string>("create_project_from_template", {
    parent,
    name,
    template,
  });
}

// ── workspace-scoped mutations (model studio::files, issue #17) ──────────────
// Every mutation is guarded to the open workspace `root` in Rust; the
// open-tab coordination (rename-follow, delete-closes-tab) lives on the
// Workbench (state.svelte.ts), not here.

/** Rename (move) `src` to `dst`, both inside `root`. Rejects a collision. */
export function renamePath(
  root: string,
  src: string,
  dst: string,
): Promise<void> {
  return invoke<void>("rename_path", { root, src, dst });
}

/** Duplicate `path` beside itself under a derived name; returns the new path. */
export function duplicatePath(root: string, path: string): Promise<string> {
  return invoke<string>("duplicate_path", { root, path });
}

/** Create an empty file `<parent>/<name>` inside `root`; returns its path. */
export function createFile(
  root: string,
  parent: string,
  name: string,
): Promise<string> {
  return invoke<string>("create_file", { root, parent, name });
}

/** Create a directory `<parent>/<name>` inside `root`; returns its path. */
export function createDir(
  root: string,
  parent: string,
  name: string,
): Promise<string> {
  return invoke<string>("create_dir", { root, parent, name });
}

/** Delete `path` (inside `root`) to the OS Recycle Bin — never a hard delete. */
export function deleteToTrash(root: string, path: string): Promise<void> {
  return invoke<void>("delete_to_trash", { root, path });
}

/** Detected Rust toolchain; null = the tool is not on PATH. */
export interface ToolchainStatus {
  cargo: string | null;
  rustup: string | null;
}

/** How a build run ended (`build://done` payload). */
export interface BuildDone {
  succeeded: boolean;
  exit_code: number;
  no_op: boolean;
}

/** What an install run did. */
export interface InstallReport {
  copied: number;
  files: string[];
}

/** What an uninstall run did. */
export interface UninstallReport {
  removed: number;
  files: string[];
}

/** Whether the project's deployed files are present and current. */
export interface InstallStatus {
  installed: boolean;
  up_to_date: boolean;
}

/**
 * Start a build of the project at `root`. Resolves once cargo is spawned
 * (or immediately for non-Rust projects); output and completion arrive as
 * `build://output` / `build://done` events.
 */
export function buildProject(root: string): Promise<void> {
  return invoke<void>("build_project", { root });
}

/** Probe `cargo` / `rustup` on PATH; absence is data, never an error. */
export function toolchainStatus(): Promise<ToolchainStatus> {
  return invoke<ToolchainStatus>("toolchain_status");
}

/** Apply the project's dcs-studio.toml [[install]] rules to this machine. */
export function installProject(root: string): Promise<InstallReport> {
  return invoke<InstallReport>("install_project", { root });
}

/** Check whether the project's deployed files are present and current. */
export function installStatus(root: string): Promise<InstallStatus> {
  return invoke<InstallStatus>("install_status", { root });
}

/** Remove every file the project's [[install]] rules deployed. */
export function uninstallProject(root: string): Promise<UninstallReport> {
  return invoke<UninstallReport>("uninstall_project", { root });
}

/** Snapshot of the editor↔DCS link state (see `dcs_status` in dcs.rs). */
export interface DcsStatus {
  connected: boolean;
  sim_running: boolean;
  latency_ms: number | null;
}

/**
 * Forward a JSON-RPC call to the in-DCS bridge (e.g. `dcsCall("ping")`).
 * In the app this goes via the Rust dcs-bridge-client; in a plain browser
 * (vite dev, Playwright) it talks to the bridge WebSocket directly.
 */
export function dcsCall(method: string, params?: unknown): Promise<unknown> {
  if (!isTauri()) return wsCall(method, params);
  return invoke<unknown>("dcs_call", { method, params: params ?? null });
}

/** Current DCS link state — used to seed the UI before any events arrive. */
export function dcsStatus(): Promise<DcsStatus> {
  return invoke<DcsStatus>("dcs_status");
}

/** A detected DCS write dir under `%USERPROFILE%\Saved Games`. */
export interface DcsInstall {
  name: string;
  write_dir: string;
  valid: boolean;
}

/** What's installed in a write dir vs the bridge this build would install. */
export interface InjectionStatus {
  source_available: boolean;
  source_version: string;
  dll_installed: boolean;
  dll_up_to_date: boolean;
  hook_installed: boolean;
  hook_up_to_date: boolean;
  dll_dest: string;
  hook_dest: string;
}

/** Scan Saved Games for DCS write dirs (plain `DCS` first). */
export function dcsDetectInstalls(): Promise<DcsInstall[]> {
  return invoke<DcsInstall[]>("dcs_detect_installs");
}

/** Inspect a write dir for installed/outdated bridge DLL + hook. */
export function dcsInjectionStatus(writeDir: string): Promise<InjectionStatus> {
  return invoke<InjectionStatus>("dcs_injection_status", { writeDir });
}

/** Install (or update) the bridge DLL + hook into a write dir. */
export function dcsInject(writeDir: string): Promise<InjectionStatus> {
  return invoke<InjectionStatus>("dcs_inject", { writeDir });
}

/** Remove the bridge DLL + hook from a write dir. */
export function dcsEject(writeDir: string): Promise<InjectionStatus> {
  return invoke<InjectionStatus>("dcs_eject", { writeDir });
}

/** A detected `<install>\Scripts\MissionScripting.lua` candidate. */
export interface MissionScriptFile {
  variant: string;
  path: string;
  exists: boolean;
}

/** One sanitization item: present = its line exists, sanitized = line active. */
export interface SanitizeItem {
  name: string;
  present: boolean;
  sanitized: boolean;
}

/** Sanitization state of a MissionScripting.lua file. */
export interface MissionScriptStatus {
  exists: boolean;
  writable: boolean;
  backup_exists: boolean;
  in_program_files: boolean;
  items: SanitizeItem[];
}

/** Find MissionScripting.lua files via the registry + common install roots. */
export function dcsDetectMissionScripts(): Promise<MissionScriptFile[]> {
  return invoke<MissionScriptFile[]>("dcs_detect_mission_scripts");
}

/** Inspect a MissionScripting.lua's sanitization items. */
export function dcsMissionScriptStatus(
  path: string,
): Promise<MissionScriptStatus> {
  return invoke<MissionScriptStatus>("dcs_mission_script_status", { path });
}

/** Set desired sanitized state per item, e.g. `{ lfs: false }` to desanitize. */
export function dcsMissionScriptSet(
  path: string,
  items: Record<string, boolean>,
): Promise<MissionScriptStatus> {
  return invoke<MissionScriptStatus>("dcs_mission_script_set", { path, items });
}

/** Restore the pristine stock file from `<path>.dcsstudio.bak`. */
export function dcsMissionScriptRestore(
  path: string,
): Promise<MissionScriptStatus> {
  return invoke<MissionScriptStatus>("dcs_mission_script_restore", { path });
}

// ── Integrated terminal (model/studio/term.pds, issue #13) ──
// Thin wrappers over the term_* commands. Output arrives as `term://data/{id}`
// events and the stream's end as `term://exit/{id}`; both are subscribed in
// Terminal.svelte / terminal.svelte.ts, not here.

/** One environment variable layered onto a terminal profile's child. */
export interface TermEnvVar {
  key: string;
  value: string;
}

/** A resolved terminal launch spec (model `Profile`, already resolved by the
 *  frontend to a concrete command, cwd, and size). */
export interface TermSpawnSpec {
  profileId: string;
  label: string;
  command: string;
  args: string[];
  cwd: string | null;
  env: TermEnvVar[];
  rows: number;
  cols: number;
}

/** A live terminal session (model `Session`). */
export interface TermSession {
  id: string;
  profileId: string;
  label: string;
}

/** A session's replay tail (base64) + the byte offset of its end (model
 *  `Terminal.Replay`): a remounting view writes the decoded bytes, then ignores
 *  any live chunk whose `seq` is `<= seq` here — so replay and live never gap or
 *  repeat. */
export interface TermReplay {
  data: string;
  seq: number;
}

/** `term://data/{id}` payload — a chunk of output (base64-encoded, to cross the
 *  IPC as a compact string rather than a JSON array of per-byte numbers) and its
 *  running byte offset. */
export interface TermData {
  data: string;
  seq: number;
}

/** `term://exit/{id}` payload — the child's exit status when one is available. */
export interface TermExit {
  code: number | null;
}

/** The detected default shell for the built-in shell profile. */
export interface TermShell {
  command: string;
  args: string[];
}

/** Spawn a session from a resolved spec; `harness` injects the MCP discovery path. */
export function termSpawn(
  id: string,
  spec: TermSpawnSpec,
  harness: boolean,
): Promise<void> {
  return invoke<void>("term_spawn", { id, spec, harness });
}

/** Send xterm's `onData` (keystrokes / escape sequences) to a session. */
export function termWrite(id: string, data: string): Promise<void> {
  return invoke<void>("term_write", { id, data });
}

/** Resize a session's pseudo-terminal to fitted cell dimensions. */
export function termResize(id: string, rows: number, cols: number): Promise<void> {
  return invoke<void>("term_resize", { id, rows, cols });
}

/** Kill a session and clean up its child, pty, and replay buffer. */
export function termKill(id: string): Promise<void> {
  return invoke<void>("term_kill", { id });
}

/** Fetch a session's replay buffer + splice point (for a freshly mounted view). */
export function termReplay(id: string): Promise<TermReplay> {
  return invoke<TermReplay>("term_replay", { id });
}

/** The live sessions, for rebuilding the tab strip. */
export function termList(): Promise<TermSession[]> {
  return invoke<TermSession[]>("term_list");
}

/** The detected default shell (prefer pwsh, then PowerShell, then cmd). */
export function termDefaultShell(): Promise<TermShell> {
  return invoke<TermShell>("term_default_shell");
}

/** Open the native folder picker; returns the chosen path or null if cancelled. */
export async function pickFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}
