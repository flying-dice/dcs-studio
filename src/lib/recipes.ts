// DCS Recipes — a static, searchable catalog of small Lua snippets across the
// whole dcs_studio.dll surface plus the DCS hooks API (issue #49 Part B). Each
// recipe runs in the GUI/hooks Lua state via the Lua console (`eval`), which
// runs `loadstring(code)()` and serialises the RETURN value back — so every
// snippet ends in `return …` to show its result. The bridge is reached with
// `require("dcs_studio")` (the hook keeps it local, not a global).
//
// Pure, runes-free content + filter logic, kept out of the runes store so the
// standalone vitest config (node env, no svelte plugin) can cover catalog
// integrity and the search/category filter. The panel store only orchestrates.
//
// Snippet APIs are faithful to crates/dcs-bridge/types/dcs_studio.d.lua (the
// generated surface) and the DCS GameGUI hooks API (DCS.*/net.*/lfs/log). The
// dcs_studio.* helpers return (value, err) tuples; happy-path snippets show the
// value and surface err where it's instructive.

/** The recipe categories, in display order. `id` is stable (persisted nowhere,
 *  but the Database panel deep-links to "sqlite"); `label` is the chip text. */
export const RECIPE_CATEGORIES = [
  { id: "dcs", label: "DCS Basics" },
  { id: "bridge", label: "Bridge" },
  { id: "serde", label: "Serialization" },
  { id: "files", label: "File Dump" },
  { id: "sqlite", label: "SQLite" },
  { id: "logging", label: "Logging" },
  { id: "debug", label: "Debugging" },
] as const;

export type RecipeCategory = (typeof RECIPE_CATEGORIES)[number]["id"];

/** One catalog entry — a titled, categorised Lua snippet. `needsMission` flags
 *  snippets whose data is only live once a mission is running (model time > 0);
 *  `tags` widen search beyond the title/blurb (e.g. the API symbols used). */
export interface Recipe {
  id: string;
  category: RecipeCategory;
  title: string;
  blurb: string;
  code: string;
  tags?: string[];
  needsMission?: boolean;
}

/** The human label for a category id (chip text, card badge). */
export function categoryLabel(id: RecipeCategory): string {
  return RECIPE_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

export const RECIPES: Recipe[] = [
  // ── DCS Basics — the GameGUI/hooks API reachable from `eval`. ───────────────
  {
    id: "dcs-model-time",
    category: "dcs",
    title: "Mission (model) time",
    blurb: "Seconds of simulated time. 0 at the main menu — the simplest probe for whether a mission is running.",
    tags: ["DCS.getModelTime", "time", "running", "mission"],
    code: `return DCS.getModelTime()`,
  },
  {
    id: "dcs-real-time",
    category: "dcs",
    title: "Real time",
    blurb: "Seconds of wall-clock time since the sim process started — advances even while paused.",
    tags: ["DCS.getRealTime", "time", "wallclock"],
    code: `return DCS.getRealTime()`,
  },
  {
    id: "dcs-mission-name",
    category: "dcs",
    title: "Current mission name",
    blurb: "The loaded mission's name (empty at the menu).",
    tags: ["DCS.getMissionName", "mission"],
    code: `return DCS.getMissionName()`,
  },
  {
    id: "dcs-theatre",
    category: "dcs",
    title: "Theatre / map",
    blurb: "The map the loaded mission is set on, read out of the mission table.",
    tags: ["DCS.getCurrentMission", "theatre", "map"],
    needsMission: true,
    code: `local m = DCS.getCurrentMission()
return m and m.mission and m.mission.theatre or "no mission loaded"`,
  },
  {
    id: "dcs-pause-state",
    category: "dcs",
    title: "Pause state",
    blurb: "Whether the simulation is currently paused.",
    tags: ["DCS.getPause", "pause"],
    code: `return DCS.getPause()`,
  },
  {
    id: "dcs-players",
    category: "dcs",
    title: "Players & coalitions",
    blurb: "Every connected player's name and side via net.*. In single-player this is just you; richer in multiplayer.",
    tags: ["net.get_player_list", "net.get_player_info", "players", "coalition"],
    needsMission: true,
    code: `local out = {}
for _, id in ipairs(net.get_player_list()) do
  local info = net.get_player_info(id)
  out[#out + 1] = { id = id, name = info and info.name, side = info and info.side }
end
return out`,
  },
  {
    id: "dcs-writedir",
    category: "dcs",
    title: "DCS write directory",
    blurb: "The Saved Games\\DCS path everything (logs, tracks, the dcs_studio DBs) is written under.",
    tags: ["lfs.writedir", "path", "savedgames"],
    code: `return lfs.writedir()`,
  },
  {
    id: "dcs-log-write",
    category: "dcs",
    title: "Write to dcs.log",
    blurb: "Append a line to DCS's own log under your own subsystem tag — handy for tracing from a mission.",
    tags: ["log.write", "log.INFO", "logging"],
    code: `log.write("DcsStudio", log.INFO, "hello from a recipe")
return "wrote a line to dcs.log"`,
  },

  // ── Bridge Basics — the dcs_studio module itself. ──────────────────────────
  {
    id: "bridge-hello",
    category: "bridge",
    title: "Bridge module & version",
    blurb: "Confirm the dcs_studio DLL is loaded and read the dcs-bridge build it came from.",
    tags: ["require", "dcs_studio", "version", "ping"],
    code: `local studio = require("dcs_studio")
return { name = studio.name, version = studio.version }`,
  },
  {
    id: "bridge-emit-dlua",
    category: "bridge",
    title: "Live type definitions (.d.lua)",
    blurb: "Dump the EmmyLua type defs for the running DLL surface — the same defs the editor uses for hover/completion.",
    tags: ["emit_dlua", "types", "d.lua", "autocomplete"],
    code: `return require("dcs_studio").emit_dlua()`,
  },

  // ── Serialization — json / toml helpers. ───────────────────────────────────
  {
    id: "serde-json-encode",
    category: "serde",
    title: "Encode JSON (pretty)",
    blurb: "Encode a Lua table to indented JSON.",
    tags: ["json.encode", "json", "encode", "pretty"],
    code: `local studio = require("dcs_studio")
return studio.json.encode({ hello = "world", list = { 1, 2, 3 } }, { pretty = true })`,
  },
  {
    id: "serde-json-decode",
    category: "serde",
    title: "Decode JSON",
    blurb: "Parse a JSON string into a Lua value.",
    tags: ["json.decode", "json", "decode", "parse"],
    code: `local studio = require("dcs_studio")
local value, err = studio.json.decode('{"a":1,"b":[2,3]}')
return value or { error = err }`,
  },
  {
    id: "serde-json-safe",
    category: "serde",
    title: "Sim-safe JSON encode",
    blurb: "safe_encode coerces NaN/Inf → null and lossy non-UTF-8 instead of failing — never panics on sim data.",
    tags: ["json.safe_encode", "json", "NaN", "Inf"],
    code: `local studio = require("dcs_studio")
return studio.json.safe_encode({ ok = 1, nan = 0 / 0, inf = 1 / 0 })`,
  },
  {
    id: "serde-toml-encode",
    category: "serde",
    title: "Encode TOML",
    blurb: "Encode a Lua table to TOML (the top level must be a table).",
    tags: ["toml.encode", "toml", "config"],
    code: `local studio = require("dcs_studio")
return studio.toml.encode({ server = { host = "127.0.0.1", port = 25569 } })`,
  },

  // ── File Dump — write sim data under the guarded write root. ────────────────
  {
    id: "files-write-text",
    category: "files",
    title: "Write a text file",
    blurb: "Write text under lfs.writedir(). The path is guarded — an escape out of the write root is refused.",
    tags: ["file.write_text", "write", "text"],
    code: `local studio = require("dcs_studio")
local ok, err = studio.file.write_text("dcs_studio/hello.txt", "hi from a recipe\\n")
return ok and "wrote dcs_studio/hello.txt" or { error = err }`,
  },
  {
    id: "files-write-json",
    category: "files",
    title: "Write a JSON file",
    blurb: "Sim-safe-encode a value and write it as indented JSON in one call.",
    tags: ["file.write_json", "json", "write", "pretty"],
    code: `local studio = require("dcs_studio")
local ok, err = studio.file.write_json("dcs_studio/state.json", { t = DCS.getModelTime(), ok = true }, { pretty = true })
return ok and "wrote dcs_studio/state.json" or { error = err }`,
  },
  {
    id: "files-write-csv",
    category: "files",
    title: "Write a CSV file",
    blurb: "Write rows (an array of arrays of scalars) as RFC-4180 CSV.",
    tags: ["file.write_csv", "csv", "write", "export"],
    code: `local studio = require("dcs_studio")
local rows = { { "id", "label" }, { 1, "alpha" }, { 2, "bravo" } }
local ok, err = studio.file.write_csv("dcs_studio/rows.csv", rows)
return ok and "wrote dcs_studio/rows.csv" or { error = err }`,
  },
  {
    id: "files-dump",
    category: "files",
    title: "Dump by extension",
    blurb: "file.dump infers the format from the path extension (.json / .csv / else text) — one call for any of them.",
    tags: ["file.dump", "dump", "json", "csv"],
    code: `local studio = require("dcs_studio")
local ok, err = studio.file.dump("dcs_studio/dump.json", { saved = DCS.getRealTime() })
return ok and "dumped dcs_studio/dump.json" or { error = err }`,
  },

  // ── SQLite — embedded DB under the write root (browse it in the Database panel). ─
  {
    id: "sqlite-hello",
    category: "sqlite",
    title: "Hello, database",
    blurb: "Open (creating) a DB, make a table, insert a row, read it back. Browse the file afterwards in the Database panel.",
    tags: ["sqlite.open", "exec", "query", "create table", "insert"],
    code: `local studio = require("dcs_studio")
local db, err = studio.sqlite.open("recipes_demo.db")
if not db then return { error = err } end
db:exec([[CREATE TABLE IF NOT EXISTS hits (id INTEGER PRIMARY KEY, at REAL, note TEXT)]])
db:exec("INSERT INTO hits (at, note) VALUES (?, ?)", { DCS.getModelTime(), "hello" })
local rows = db:query("SELECT id, at, note FROM hits ORDER BY id DESC LIMIT 5")
db:close()
return rows`,
  },
  {
    id: "sqlite-telemetry",
    category: "sqlite",
    title: "Per-frame telemetry",
    blurb: "Pattern for sampling state into a table. Keep it SMALL — writing every frame for a whole sortie fills the disk fast; sample sparsely or cap rows.",
    tags: ["sqlite", "telemetry", "insert", "transaction", "per-frame"],
    needsMission: true,
    code: `local studio = require("dcs_studio")
local db = studio.sqlite.open("telemetry.db")
if not db then return "open failed" end
db:exec([[CREATE TABLE IF NOT EXISTS samples (t REAL, paused INTEGER)]])
-- One sample now; in a real probe you'd call this from a throttled callback.
db:exec("INSERT INTO samples (t, paused) VALUES (?, ?)", { DCS.getModelTime(), DCS.getPause() and 1 or 0 })
local n = db:query("SELECT count(*) AS n FROM samples")
db:close()
return n`,
  },
  {
    id: "sqlite-top-n",
    category: "sqlite",
    title: "Top-N query",
    blurb: "Order and limit — the read shape the Database panel pre-fills for any table.",
    tags: ["sqlite", "query", "order by", "limit", "top"],
    code: `local studio = require("dcs_studio")
local db = studio.sqlite.open("recipes_demo.db")
if not db then return "run the Hello, database recipe first" end
local rows = db:query("SELECT id, at, note FROM hits ORDER BY at DESC LIMIT 10")
db:close()
return rows`,
  },
  {
    id: "sqlite-export-csv",
    category: "sqlite",
    title: "Export a query to CSV",
    blurb: "Run a query, then hand the rows to file.write_csv — the export the Database panel doesn't do for you yet.",
    tags: ["sqlite", "query", "file.write_csv", "csv", "export"],
    code: `local studio = require("dcs_studio")
local db = studio.sqlite.open("recipes_demo.db")
if not db then return "run the Hello, database recipe first" end
local rows = db:query("SELECT id, at, note FROM hits ORDER BY id") or {}
db:close()
local csv = { { "id", "at", "note" } }
for _, r in ipairs(rows) do csv[#csv + 1] = { r.id, r.at, r.note } end
local ok, err = studio.file.write_csv("dcs_studio/hits.csv", csv)
return ok and ("exported " .. (#csv - 1) .. " rows -> dcs_studio/hits.csv") or { error = err }`,
  },
  {
    id: "sqlite-memory",
    category: "sqlite",
    title: "In-memory scratch DB",
    blurb: "Open \":memory:\" for an ephemeral DB — quick SQL with nothing written to disk.",
    tags: ["sqlite", ":memory:", "scratch", "ephemeral"],
    code: `local db, err = require("dcs_studio").sqlite.open(":memory:")
if not db then return { error = err } end
db:exec("CREATE TABLE t (n INTEGER)")
db:exec("INSERT INTO t VALUES (1), (2), (3)")
local rows = db:query("SELECT sum(n) AS total, count(*) AS rows FROM t")
db:close()
return rows`,
  },

  // ── Logging — namespaced lines into the DCS Studio log. ────────────────────
  {
    id: "logging-namespaced",
    category: "logging",
    title: "Namespaced logger",
    blurb: "Tag every line with a namespace so your messages are greppable in the log.",
    tags: ["logger.new", "logger", "namespace", "info", "warn"],
    code: `local logger = require("dcs_studio").logger.Logger.new("my-recipe")
logger:info("started")
logger:warn("careful now")
return "wrote two lines under [my-recipe]"`,
  },
  {
    id: "logging-quick",
    category: "logging",
    title: "Quick one-off log line",
    blurb: "Log a single line with an inline namespace — no logger instance needed.",
    tags: ["logger.info", "logger", "quick"],
    code: `require("dcs_studio").logger.info("quick line", "recipe")
return "logged"`,
  },

  // ── Debugging — drive the breakpoint registry the IDE debugger uses. ───────
  {
    id: "debug-set-breakpoints",
    category: "debug",
    title: "Set breakpoints",
    blurb: "Register breakpoints for a source the way the IDE debugger does, then read the registry back.",
    tags: ["debug.set_breakpoints", "debug.breakpoints", "breakpoint"],
    code: `local dbg = require("dcs_studio").debug
local count = dbg.set_breakpoints("=scratch", { 3, 7, 11 })
return { set = count, registry = dbg.breakpoints() }`,
  },
  {
    id: "debug-paused",
    category: "debug",
    title: "Inspect the pause snapshot",
    blurb: "Read the current pause snapshot (JSON of source/line/locals) — populated only while stopped at a breakpoint.",
    tags: ["debug.paused", "pause", "snapshot", "inspect"],
    needsMission: true,
    code: `return require("dcs_studio").debug.paused() or "not paused"`,
  },
];

/** Filter the catalog by category and a free-text query. A query is split into
 *  whitespace terms; a recipe matches when EVERY term appears in its title,
 *  blurb, tags, or category — so "sqlite csv" narrows to the export recipe.
 *  An empty query (or "all" category) is the identity for that axis. */
export function filterRecipes(
  list: Recipe[],
  query: string,
  category: RecipeCategory | "all",
): Recipe[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((recipe) => {
    if (category !== "all" && recipe.category !== category) return false;
    if (terms.length === 0) return true;
    const haystack =
      `${recipe.title} ${recipe.blurb} ${(recipe.tags ?? []).join(" ")} ${recipe.category}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
