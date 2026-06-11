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

export function writeTextFile(path: string, contents: string): Promise<void> {
  return invoke<void>("write_text_file", { path, contents });
}

export function basename(path: string): Promise<string> {
  return invoke<string>("basename", { path });
}

/** Whether a path still exists on disk (used to flag stale recent projects). */
export function pathExists(path: string): Promise<boolean> {
  return invoke<boolean>("path_exists", { path });
}

/** A file to materialise inside a new project; `path` is relative to the root. */
export interface NewFile {
  path: string;
  contents: string;
}

/**
 * Scaffold a new project at `<parent>/<name>` and write the given template
 * files. Returns the absolute path of the new project root.
 */
export function createProject(
  parent: string,
  name: string,
  files: NewFile[],
): Promise<string> {
  return invoke<string>("create_project", { parent, name, files });
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

/** Open the native folder picker; returns the chosen path or null if cancelled. */
export async function pickFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}
