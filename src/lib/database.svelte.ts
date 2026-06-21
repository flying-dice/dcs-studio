// DatabaseBrowser — the Database tool window's state (model/studio/database.pds):
// the SQLite files the in-DCS dcs_studio.dll writes under lfs.writedir(),
// browsed READ-ONLY. Discovery runs on project open (model RefreshDatabases);
// selecting a file lists its tables (OpenDatabase); running SQL returns capped
// rows (RunQuery). All three backend calls are guarded read-only and
// write-root-contained in Rust — this store only orchestrates and renders.
//
// A separate singleton from `app` (same convention as `todos`): state.svelte.ts
// announces project-open/close; the panel reads here. The backend is injectable
// (the same seam as TodoScanner) so a lab page / e2e can drive the real store
// without Tauri.

import { invoke } from "@tauri-apps/api/core";

import { Generation } from "./database-gen";
import {
  defaultQuery,
  messageOf,
  type DatabaseFile,
  type QueryResult,
  type TableInfo,
} from "./database-util";

/** The read-only DB backend — Tauri commands in the app, injectable for tests. */
export interface DbFns {
  writeDir(): Promise<string | null>;
  discover(): Promise<DatabaseFile[]>;
  tables(path: string): Promise<TableInfo[]>;
  query(path: string, sql: string): Promise<QueryResult>;
}

const tauriDb: DbFns = {
  writeDir: () => invoke<string | null>("db_write_dir"),
  discover: () => invoke<DatabaseFile[]>("db_discover"),
  tables: (path) => invoke<TableInfo[]>("db_tables", { path }),
  query: (path, sql) => invoke<QueryResult>("db_query", { path, sql }),
};

export class DatabaseBrowser {
  constructor(private readonly db: DbFns = tauriDb) {}

  /** The resolved DCS write root the panel is browsing (null when no DCS). */
  writeDir = $state<string | null>(null);
  /** Discovered SQLite files, sorted by name. */
  files = $state<DatabaseFile[]>([]);
  /** The opened database's path; null while showing the file list. */
  selected = $state<string | null>(null);
  /** The opened database's tables. */
  tables = $state<TableInfo[]>([]);
  /** The query box contents. */
  sql = $state("");
  /** The last query result; null before the first run or after an error. */
  result = $state<QueryResult | null>(null);
  /** The last error message (guard refusal, failed open, or SQL error). */
  error = $state<string | null>(null);

  discovering = $state(false);
  loadingTables = $state(false);
  running = $state(false);

  // Two generation guards keep independent lifecycles from stranding each
  // other's in-flight flags: the file list (discovery) is begun by `refresh`;
  // the opened-database lifecycle (tables/query) by `select`/`run`/`openTable`/
  // `clearSelection`. A Refresh mid-query must not orphan `running`, nor a
  // re-select orphan `loadingTables`. (Supersession contract: `./database-gen`.)
  private discoverGen = new Generation();
  private selectionGen = new Generation();

  /** Discover databases under the write root (model `RefreshDatabases`). A
   *  failure leaves the list empty — non-fatal, the panel just shows nothing. */
  async refresh(): Promise<void> {
    const generation = this.discoverGen.begin();
    this.discovering = true;
    try {
      const writeDir = await this.db.writeDir();
      if (this.discoverGen.isCurrent(generation)) this.writeDir = writeDir;
      const files = await this.db.discover();
      if (this.discoverGen.isCurrent(generation)) this.files = files;
    } catch (error) {
      console.error("database discovery failed:", error);
      if (this.discoverGen.isCurrent(generation)) this.files = [];
    } finally {
      if (this.discoverGen.isCurrent(generation)) this.discovering = false;
    }
  }

  /** Open a database and list its tables (model `OpenDatabase`). */
  async select(path: string): Promise<void> {
    const generation = this.selectionGen.begin();
    this.running = false; // a new selection supersedes any in-flight query
    this.selected = path;
    this.tables = [];
    this.result = null;
    this.error = null;
    this.sql = "";
    this.loadingTables = true;
    try {
      const tables = await this.db.tables(path);
      if (!this.selectionGen.isCurrent(generation)) return;
      this.tables = tables;
    } catch (error) {
      if (this.selectionGen.isCurrent(generation)) this.error = messageOf(error);
    } finally {
      if (this.selectionGen.isCurrent(generation)) this.loadingTables = false;
    }
  }

  /** Pre-fill and run a table's default `SELECT * … LIMIT 100`. Supersedes any
   *  query already in flight (it bumps the selection generation via `run`). */
  async openTable(table: string): Promise<void> {
    this.sql = defaultQuery(table);
    await this.run();
  }

  /** Run the query box against the selected database (model `RunQuery`). A
   *  blank query or no selection is a no-op; a fresh run supersedes any prior
   *  one (the generation guard drops the stale result). */
  async run(): Promise<void> {
    const path = this.selected;
    const sql = this.sql.trim();
    if (path === null || sql === "") return;
    const generation = this.selectionGen.begin();
    this.loadingTables = false; // a run supersedes an in-flight table load
    this.running = true;
    this.error = null;
    try {
      const result = await this.db.query(path, sql);
      if (!this.selectionGen.isCurrent(generation)) return;
      this.result = result;
    } catch (error) {
      if (!this.selectionGen.isCurrent(generation)) return;
      this.error = messageOf(error);
      this.result = null;
    } finally {
      if (this.selectionGen.isCurrent(generation)) this.running = false;
    }
  }

  /** Back to the database list, dropping the opened database's state and
   *  superseding any in-flight tables/query call. */
  clearSelection(): void {
    this.selectionGen.supersede();
    this.selected = null;
    this.tables = [];
    this.sql = "";
    this.result = null;
    this.error = null;
    this.loadingTables = false;
    this.running = false;
  }

  /** Forget everything (project closed or switched). */
  reset(): void {
    this.discoverGen.supersede();
    this.selectionGen.supersede();
    this.writeDir = null;
    this.files = [];
    this.selected = null;
    this.tables = [];
    this.sql = "";
    this.result = null;
    this.error = null;
    this.discovering = false;
    this.loadingTables = false;
    this.running = false;
  }
}

/** The app-wide instance (a lab/e2e harness builds its own with a fake backend). */
export const database = new DatabaseBrowser();
