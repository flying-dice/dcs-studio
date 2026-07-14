-- DCS unit-database curation library for the GUI bridge. The GameGUI hook state
-- carries a rich `db` global (Units, Weapons, …); this module turns that raw,
-- cyclic graph into the plain-data shapes the db_* JSON-RPC methods return. It is
-- a distinct responsibility from method registration, so it lives in its own
-- chunk (like the console runtime and the debug engine).
--
-- Delivered by lib.rs `load_register_methods` for the GUI bridge ONLY, PREPENDED
-- to gui_methods.lua so the following `return function(router, deps)` closes over
-- `GUI_DB` as a local. The db_* handlers stay in gui_methods.lua as thin wiring;
-- everything that INTERPRETS the database is here. `db` is read as a live global
-- from inside these functions, never at load time, so composing this ahead of the
-- registration chunk needs no DCS API (the OpenRPC golden loads it headless).
local GUI_DB = {
  DB_CAP = 2000, -- max rows a listing returns before it flags `truncated`
  RAW_MAX_DEPTH = 12, -- db_unit raw / guns sanitizer recursion guard
}

function GUI_DB.need_db()
  if type(db) ~= "table" then
    error(
      "the DCS unit database (db) is not available here — db_* methods are GUI-bridge only and need DCS loaded (the sim must be foreground so its RPC queue pumps)",
      0
    )
  end
end

-- Detect a real unit category inside a `db.Units` child: the child holds an
-- array-of-records under a singular key (Planes→Plane, Cars→Car), and a real
-- unit record's `.type` is a STRING (this is what excludes GT_t, whose
-- WSN_t[i].type is a number, plus Skills/WWIIstructures which have no such
-- inner array). Returns entry_key, array or nil.
local function detect_category(child)
  for k, v in pairs(child) do
    if type(v) == "table" and #v > 0 and type(v[1]) == "table" and type(v[1].type) == "string" then
      return tostring(k), v
    end
  end
  return nil
end

-- Category map + per-category type→record index, cached module-locally and
-- rebuilt when `db` changes identity (a fresh db table on reload).
local db_cache = nil
function GUI_DB.get_cache()
  if db_cache and db_cache.db == db then
    return db_cache
  end
  local categories, by_name = {}, {}
  if type(db) == "table" and type(db.Units) == "table" then
    for name, child in pairs(db.Units) do
      if type(child) == "table" then
        local entry_key, arr = detect_category(child)
        if entry_key then
          local entry = {
            name = tostring(name),
            entry_key = entry_key,
            array = arr,
            count = #arr,
            type_index = nil,
          }
          categories[#categories + 1] = entry
          by_name[entry.name] = entry
        end
      end
    end
    table.sort(categories, function(a, b) return a.name < b.name end)
  end
  db_cache = { db = db, categories = categories, by_name = by_name }
  return db_cache
end

-- Lazy lowercase type→record index for one category.
function GUI_DB.type_index(entry)
  if entry.type_index then
    return entry.type_index
  end
  local idx = {}
  for i = 1, #entry.array do
    local rec = entry.array[i]
    if type(rec) == "table" and type(rec.type) == "string" then
      idx[string.lower(rec.type)] = rec
    end
  end
  entry.type_index = idx
  return idx
end

-- Depth-capped, cycle-safe deep copy into plain data (functions/userdata/
-- threads → their type name), so a raw record is safe for the Rust serializer
-- (which has no cycle guard). Integer-keyed tables keep their keys, so arrays
-- stay arrays.
function GUI_DB.sanitize(v, depth, seen)
  local t = type(v)
  if t == "table" then
    if seen[v] then
      return "<cycle>"
    end
    if depth <= 0 then
      return "<max depth>"
    end
    seen[v] = true
    local out = {}
    for k, val in pairs(v) do
      local kk = (type(k) == "string" or type(k) == "number") and k or tostring(k)
      out[kk] = GUI_DB.sanitize(val, depth - 1, seen)
    end
    seen[v] = nil
    return out
  elseif t == "function" or t == "userdata" or t == "thread" then
    return t
  end
  return v -- string / number / boolean / nil
end

-- Human-readable attribute names: a unit's `attribute` table mixes numeric
-- ids and string names; the strings are the modder-facing attribute list.
function GUI_DB.attribute_names(rec)
  local out = {}
  if type(rec.attribute) == "table" then
    for _, v in pairs(rec.attribute) do
      if type(v) == "string" then
        out[#out + 1] = v
      end
    end
    table.sort(out)
  end
  return out
end

-- Curated numeric performance fields, read defensively across categories
-- (planes/helicopters/ships/cars use different subsets); only those present
-- as numbers appear.
local PERF_KEYS = {
  "Mach_max", "M_max", "M_empty", "M_fuel_max", "M_nominal",
  "V_max_h", "V_max_sea_level", "V_max", "V_max_cruise", "V_land", "V_take_off",
  "MaxSpeed", "max_velocity", "Vy_max",
  "H_max", "H_stat_max", "H_din_one_eng",
  "range", "detection_range_max", "DetectionRange", "ThreatRange",
  "mass", "life", "AmmoWeight",
  "length", "height", "wing_span", "Length", "Width", "Height",
  "RCS", "engines_count", "crew_members_count",
}
function GUI_DB.perf_fields(rec)
  local out = {}
  for _, key in ipairs(PERF_KEYS) do
    if type(rec[key]) == "number" then
      out[key] = rec[key]
    end
  end
  return out
end

-- Resolve a store CLSID against db.Weapons.ByCLSID → curated weapon info, or
-- nil when unknown (the caller keeps the bare CLSID).
local function resolve_weapon(clsid)
  local by = type(db.Weapons) == "table" and db.Weapons.ByCLSID
  local w = type(by) == "table" and by[clsid]
  if type(w) ~= "table" then
    return nil
  end
  return { display_name = w.displayName, name = w.name, category = w.category }
end

-- Pylons → per-pylon compatible stores (the DB's answer to "payloads":
-- pylons + per-pylon store CLSIDs cross-referenced against db.Weapons; ME
-- loadout PRESETS are not in db).
function GUI_DB.pylons_of(rec)
  if type(rec.Pylons) ~= "table" then
    return nil
  end
  local out = {}
  for i = 1, #rec.Pylons do
    local p = rec.Pylons[i]
    if type(p) == "table" then
      local stores = {}
      if type(p.Launchers) == "table" then
        for j = 1, #p.Launchers do
          local l = p.Launchers[j]
          if type(l) == "table" and l.CLSID then
            stores[#stores + 1] = { clsid = l.CLSID, weapon = resolve_weapon(l.CLSID) }
          end
        end
      end
      out[#out + 1] = {
        number = p.Number,
        order = p.Order,
        type = p.Type,
        position = { x = p.X, y = p.Y, z = p.Z },
        stores = stores,
      }
    end
  end
  return out
end
