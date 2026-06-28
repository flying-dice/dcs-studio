// Pure, runes-free helpers for the Database panel (model/studio/database.pds).
// Kept out of the runes store so the standalone vitest config (node env, no
// svelte plugin) can cover the load-bearing logic — the default query, the
// "(capped)" summary, and DbError unwrapping. (Byte sizing reuses
// `formatBytes` from ./utils — no duplicate.)

import { commandErrorMessage } from "./utils";

/** A discovered SQLite file under the DCS write root (wire shape of the
 *  Rust `DatabaseFile`, camelCase). */
export interface DatabaseFile {
  path: string;
  name: string;
  sizeBytes: number;
}

/** A table in an opened database. */
export interface TableInfo {
  name: string;
  columnCount: number;
  rowCount: number;
}

/** One result row — cells pre-rendered to display strings by the reader
 *  (nulls empty, blobs elided), aligned to `QueryResult.columns`. */
export interface Row {
  cells: string[];
}

/** The outcome of a query (wire shape of the Rust `QueryResult`). */
export interface QueryResult {
  columns: string[];
  rows: Row[];
  rowCount: number;
  capped: boolean;
}

/** Double-quote a SQL identifier, escaping embedded quotes — so a table name
 *  with spaces or punctuation is a valid `FROM` target. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** The query pre-filled when a table is opened: the first 100 rows. The
 *  read-only backend still caps the result, so this is a UI convenience, not
 *  the safety bound. */
export function defaultQuery(table: string): string {
  return `SELECT * FROM ${quoteIdent(table)} LIMIT 100`;
}

/** The grid's count line: "showing N row(s)", flagged when the backend capped
 *  the result. */
export function resultSummary(result: Pick<QueryResult, "rowCount" | "capped">): string {
  const noun = result.rowCount === 1 ? "row" : "rows";
  return `showing ${result.rowCount} ${noun}${result.capped ? " (capped)" : ""}`;
}

/** The message from a caught DB command rejection: the backend serialises
 *  `DbError` as `{ message }`, so unwrap that before falling back to the
 *  generic formatter. */
export function messageOf(error: unknown): string {
  return commandErrorMessage(error);
}
