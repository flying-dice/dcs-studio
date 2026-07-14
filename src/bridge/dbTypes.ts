// DCS unit-database (db_*) payload types for the GUI bridge's db_export /
// db_categories / db_unit_types / db_weapons methods. Consumed only by the
// bridge adapter tier (bridge/client.ts + bridge/dbExport.ts), so they live
// here rather than in core. Type-only — no runtime.

/** A category from `db_categories` (a real category inside db.Units). */
export interface DbCategory {
  name: string;
  entry_key: string;
  count: number;
}

/** A row from `db_unit_types`. */
export interface DbUnitType {
  type: string;
  display_name?: string;
  category: string;
}

/** A row from `db_weapons` (a store from db.Weapons). */
export interface DbWeapon {
  clsid: string;
  display_name?: string;
  name?: string;
  category?: number;
}

/** The result of `db_export`: the file the sim wrote and its size. */
export interface DbExportResult {
  path: string;
  bytes: number;
}

/** What `db_export`'s `what` selects: everything, weapons, one category, or one
 * unit. `category:`/`unit:` carry the name/type after the prefix. */
export type DbExportWhat = "all" | "weapons" | `category:${string}` | `unit:${string}`;
