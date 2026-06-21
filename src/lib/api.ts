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

/** Start the recursive workspace fs watcher on `path` (issue #40). Replaces any
 * prior watch. A no-op in the browser (no Tauri backend). */
export function watchStart(path: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke<void>("watch_start", { path });
}

/** Stop the workspace fs watcher. A no-op in the browser. */
export function watchStop(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return invoke<void>("watch_stop");
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

export interface LogTail {
  text: string;
  truncated: boolean;
}

/** Tail the DCS log (`{writeDir}\Logs\dcs.log`), at most `maxBytes` from the end
 *  (model studio::logs `DcsLog.Tail`). Empty outside the desktop app, or when no
 *  DCS write dir / log exists yet. */
export function dcsLogTail(maxBytes = 256 * 1024): Promise<LogTail> {
  if (!isTauri()) return Promise.resolve({ text: "", truncated: false });
  return invoke<LogTail>("dcs_log_tail", { maxBytes });
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

// ── signed packages (model studio::package, issue #37) ──────────────────────

/** A discovered or installed `.dcspkg`. */
export interface PackageEntry {
  id: string;
  name: string;
  author: string;
  signed_at: string;
  path: string;
}

/** What an install run linked into the DCS roots. */
export interface PackageInstallReport {
  linked: number;
  files: string[];
}

/** An installed package no longer known-good: `status` is `"revoked"` (server
 * says invalid) or `"unverified"` (server unreachable — fail-closed). */
export interface StalePackage {
  id: string;
  author: string;
  status: string;
}

/** Pack the project at `root` into a signed `.dcspkg`; returns its path. */
export function packProject(root: string): Promise<string> {
  return invoke<string>("pack_project", { root });
}

/** Every `.dcspkg` in the auto-discovery watch folder. */
export function discoverPackages(): Promise<PackageEntry[]> {
  return invoke<PackageEntry[]>("discover_packages");
}

/** Every installed package in the content store. */
export function installedPackageList(): Promise<PackageEntry[]> {
  return invoke<PackageEntry[]>("installed_package_list");
}

/** Install a discovered package (hash-check, server-validate, link in). */
export function installPackage(artifact: string): Promise<PackageInstallReport> {
  return invoke<PackageInstallReport>("install_package", { artifact });
}

/** Uninstall an installed package by id. */
export function uninstallPackage(id: string): Promise<void> {
  return invoke<void>("uninstall_package", { id });
}

/** Re-validate installed packages; returns those whose author is now revoked. */
export function revalidatePackages(): Promise<StalePackage[]> {
  return invoke<StalePackage[]>("revalidate_packages");
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

/**
 * The IDE-hosted MCP server's status (model studio::mcp, issue #39): standard
 * MCP Streamable HTTP on a fixed loopback port, unauthenticated (loopback-only).
 * `running` is false with an `error` when the fixed port was taken (fail-closed,
 * never a random fallback). The setup-help modal turns this into editor configs.
 */
export interface McpStatus {
  running: boolean;
  port: number;
  url: string;
  error: string | null;
}

/** Snapshot the IDE's MCP server status (server starts at app boot). */
export function mcpStatus(): Promise<McpStatus> {
  return invoke<McpStatus>("mcp_status");
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

/** The result of starting a managed DCS launch. */
export interface LaunchOutcome {
  running: boolean;
  exe_path: string;
  config_backed_up: boolean;
}

/** Whether a launched DCS is still running and the config is still patched. */
export interface LaunchStatus {
  running: boolean;
  config_patched: boolean;
}

/**
 * Managed launch: assert the bridge is injected, back up + low-spec
 * Config/options.lua, and start DCS.exe. On exit the bridge is auto-ejected and
 * the config restored. `launch://done` fires once DCS exits.
 */
export function dcsLaunch(writeDir: string): Promise<LaunchOutcome> {
  return invoke<LaunchOutcome>("dcs_launch", { writeDir });
}

/** Whether a launched DCS is still running and the config still patched. */
export function dcsLaunchStatus(): Promise<LaunchStatus> {
  return invoke<LaunchStatus>("dcs_launch_status");
}

/** Stop the launched DCS, eject the bridge, and restore options.lua. */
export function dcsStop(writeDir: string): Promise<LaunchStatus> {
  return invoke<LaunchStatus>("dcs_stop", { writeDir });
}

/** A GitHub device-flow handshake to display: the user code + the URL to enter it at. */
export interface GithubDeviceCode {
  user_code: string;
  verification_uri: string;
}

/** The signed-in GitHub session — profile only; the access token stays Rust-side. */
export interface GithubSession {
  login: string;
  avatar_url: string;
}

/**
 * Begin GitHub device-flow login: returns the user code + verification URL to
 * display. The backend then polls and emits `github://authorized` (GithubSession)
 * or `github://error` ({ message }).
 */
export function githubLoginStart(): Promise<GithubDeviceCode> {
  return invoke<GithubDeviceCode>("github_login_start");
}

/**
 * Cancel an in-progress device-flow login: stops the backend poll loop so a code
 * authorized in the browser after the user cancels does not silently sign them
 * in. Called when the sign-in modal is dismissed (Cancel/X/Esc/backdrop).
 */
export function githubLoginCancel(): Promise<void> {
  return invoke<void>("github_login_cancel");
}

/**
 * Escalate the token to the publishing scope (`public_repo`, issue #12) via the
 * same device flow as sign-in — returns the code to show; success arrives on the
 * shared `github://authorized` event. Used when {@link publishCan} is false.
 */
export function githubAuthorizePublish(): Promise<GithubDeviceCode> {
  return invoke<GithubDeviceCode>("github_authorize_publish");
}

/** The cached session (profile), or null when signed out. */
export function githubSession(): Promise<GithubSession | null> {
  return invoke<GithubSession | null>("github_session");
}

/** Sign out: clear the cached token + profile; the chip returns to signed-out. */
export function githubSignOut(): Promise<void> {
  return invoke<void>("github_sign_out");
}

/**
 * A discovered Marketplace mod (model studio::market `MarketListing`): a public
 * repo tagged `dcs-studio`. `author` is the repo owner; `labels` are the repo's
 * other topics. Installability (a `dcs-studio.toml` release asset) is resolved
 * at download time, not here, so a repo without one still lists.
 */
export interface MarketListing {
  repo: string;
  name: string;
  author: string;
  description: string;
  labels: string[];
  repo_url: string;
  avatar_url: string;
  stars: number;
}

/**
 * Discover dcs-studio mods on GitHub by topic for the Marketplace. Requires a
 * GitHub sign-in (the store is gated) and searches as the logged-in user. Serves
 * a still-fresh cache without a network call unless `force` (the Refresh button);
 * a rate-limited or offline search falls back to the last cache.
 */
export function marketDiscover(force: boolean): Promise<MarketListing[]> {
  return invoke<MarketListing[]>("market_discover", { force });
}

/** One release file with its byte size (model studio::market `ReleaseAsset`). */
export interface ProductAsset {
  name: string;
  size: number;
}

/** One `[[install]]` mapping — what installs where (model `InstallEntry`). */
export interface InstallEntry {
  source: string;
  dest: string;
}

/**
 * A mod's product page (model studio::market `ProductDetail`): repo header,
 * README source (markdown), the latest release's assets + total `download_size`
 * (bytes), and the install plan from the `dcs-studio.toml` asset. `installable`
 * is true only when that asset is present and parses.
 */
export interface ProductDetail {
  repo: string;
  name: string;
  author: string;
  description: string;
  repo_url: string;
  avatar_url: string;
  stars: number;
  readme: string | null;
  release_tag: string | null;
  release_url: string | null;
  assets: ProductAsset[];
  download_size: number;
  installable: boolean;
  installs: InstallEntry[];
}

/** Load one mod's product page (README + install plan + size). Sign-in gated. */
export function marketProduct(owner: string, name: string): Promise<ProductDetail> {
  return invoke<ProductDetail>("market_product", { owner, name });
}

/** What an install pass linked into the DCS roots (model `InstallReport`). */
export interface InstallReport {
  copied: number;
  files: string[];
}

/** Install a mod: download the release payload + link it into the DCS roots. */
export function marketInstall(owner: string, name: string): Promise<InstallReport> {
  return invoke<InstallReport>("market_install", { owner, name });
}

/** Uninstall a mod by id (`owner/name`): remove its links + content store. */
export function marketUninstall(id: string): Promise<void> {
  return invoke<void>("market_uninstall", { id });
}

/** The ids (`owner/name`) of installed mods. */
export function marketInstalled(): Promise<string[]> {
  return invoke<string[]>("market_installed");
}

// ── publishing (model studio::publish, issue #12) ───────────────────────────

/** A created (or resolved) GitHub repository (model studio::publish `RepoInfo`). */
export interface RepoInfo {
  full_name: string;
  html_url: string;
  owner: string;
  name: string;
}

/** A created GitHub release (model studio::publish `ReleaseInfo`). */
export interface ReleaseInfo {
  tag: string;
  html_url: string;
}

/** Whether the cached token already carries the publishing scope (`public_repo`).
 * When false the UI runs {@link githubAuthorizePublish} first. */
export function publishCan(): Promise<boolean> {
  return invoke<boolean>("publish_can");
}

/** Share the project at `root` to GitHub: create the repo, tag `dcs-studio`,
 * init/commit/push. Requires a publish-scoped token. */
export function publishShare(root: string): Promise<RepoInfo> {
  return invoke<RepoInfo>("publish_share", { root });
}

/** Publish a release for the shared project at `root` (uploads `dcs-studio.toml`
 * so the Marketplace product page shows the install plan). */
export function publishRelease(root: string, tag: string): Promise<ReleaseInfo> {
  return invoke<ReleaseInfo>("publish_release", { root, tag });
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
