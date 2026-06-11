--[[ Generated with https://github.com/TypeScriptToLua/TypeScriptToLua ]]

local ____modules = {}
local ____moduleCache = {}
local ____originalRequire = require
local function require(file, ...)
    if ____moduleCache[file] then
        return ____moduleCache[file].value
    end
    if ____modules[file] then
        local module = ____modules[file]
        ____moduleCache[file] = { value = (select("#", ...) > 0) and module(...) or module(file) }
        return ____moduleCache[file].value
    else
        if ____originalRequire then
            return ____originalRequire(file)
        else
            error("module '" .. file .. "' not found")
        end
    end
end
____modules = {
["lualib_bundle"] = function(...) 
local function __TS__StringIncludes(self, searchString, position)
    if not position then
        position = 1
    else
        position = position + 1
    end
    local index = string.find(self, searchString, position, true)
    return index ~= nil
end

local __TS__Match = string.match

local function __TS__SourceMapTraceBack(fileName, sourceMap)
    _G.__TS__sourcemap = _G.__TS__sourcemap or ({})
    _G.__TS__sourcemap[fileName] = sourceMap
    if _G.__TS__originalTraceback == nil then
        local originalTraceback = debug.traceback
        _G.__TS__originalTraceback = originalTraceback
        debug.traceback = function(thread, message, level)
            local trace
            if thread == nil and message == nil and level == nil then
                trace = originalTraceback()
            elseif __TS__StringIncludes(_VERSION, "Lua 5.0") then
                trace = originalTraceback((("[Level " .. tostring(level)) .. "] ") .. tostring(message))
            else
                trace = originalTraceback(thread, message, level)
            end
            if type(trace) ~= "string" then
                return trace
            end
            local function replacer(____, file, srcFile, line)
                local fileSourceMap = _G.__TS__sourcemap[file]
                if fileSourceMap ~= nil and fileSourceMap[line] ~= nil then
                    local data = fileSourceMap[line]
                    if type(data) == "number" then
                        return (srcFile .. ":") .. tostring(data)
                    end
                    return (data.file .. ":") .. tostring(data.line)
                end
                return (file .. ":") .. line
            end
            local result = string.gsub(
                trace,
                "(%S+)%.lua:(%d+)",
                function(file, line) return replacer(nil, file .. ".lua", file .. ".ts", line) end
            )
            local function stringReplacer(____, file, line)
                local fileSourceMap = _G.__TS__sourcemap[file]
                if fileSourceMap ~= nil and fileSourceMap[line] ~= nil then
                    local chunkName = (__TS__Match(file, "%[string \"([^\"]+)\"%]"))
                    local sourceName = string.gsub(chunkName, ".lua$", ".ts")
                    local data = fileSourceMap[line]
                    if type(data) == "number" then
                        return (sourceName .. ":") .. tostring(data)
                    end
                    return (data.file .. ":") .. tostring(data.line)
                end
                return (file .. ":") .. line
            end
            result = string.gsub(
                result,
                "(%[string \"[^\"]+\"%]):(%d+)",
                function(file, line) return stringReplacer(nil, file, line) end
            )
            return result
        end
    end
end

local function __TS__Class(self)
    local c = {prototype = {}}
    c.prototype.__index = c.prototype
    c.prototype.constructor = c
    return c
end

local function __TS__StringStartsWith(self, searchString, position)
    if position == nil or position < 0 then
        position = 0
    end
    return string.sub(self, position + 1, #searchString + position) == searchString
end

local function __TS__New(target, ...)
    local instance = setmetatable({}, target.prototype)
    instance:____constructor(...)
    return instance
end

local function __TS__ClassExtends(target, base)
    target.____super = base
    local staticMetatable = setmetatable({__index = base}, base)
    setmetatable(target, staticMetatable)
    local baseMetatable = getmetatable(base)
    if baseMetatable then
        if type(baseMetatable.__index) == "function" then
            staticMetatable.__index = baseMetatable.__index
        end
        if type(baseMetatable.__newindex) == "function" then
            staticMetatable.__newindex = baseMetatable.__newindex
        end
    end
    setmetatable(target.prototype, base.prototype)
    if type(base.prototype.__index) == "function" then
        target.prototype.__index = base.prototype.__index
    end
    if type(base.prototype.__newindex) == "function" then
        target.prototype.__newindex = base.prototype.__newindex
    end
    if type(base.prototype.__tostring) == "function" then
        target.prototype.__tostring = base.prototype.__tostring
    end
end

local Error, RangeError, ReferenceError, SyntaxError, TypeError, URIError
do
    local function getErrorStack(self, constructor)
        if debug == nil then
            return nil
        end
        local level = 1
        while true do
            local info = debug.getinfo(level, "f")
            level = level + 1
            if not info then
                level = 1
                break
            elseif info.func == constructor then
                break
            end
        end
        if __TS__StringIncludes(_VERSION, "Lua 5.0") then
            return debug.traceback(("[Level " .. tostring(level)) .. "]")
        else
            return debug.traceback(nil, level)
        end
    end
    local function wrapErrorToString(self, getDescription)
        return function(self)
            local description = getDescription(self)
            local caller = debug.getinfo(3, "f")
            local isClassicLua = __TS__StringIncludes(_VERSION, "Lua 5.0") or _VERSION == "Lua 5.1"
            if isClassicLua or caller and caller.func ~= error then
                return description
            else
                return (description .. "\n") .. tostring(self.stack)
            end
        end
    end
    local function initErrorClass(self, Type, name)
        Type.name = name
        return setmetatable(
            Type,
            {__call = function(____, _self, message) return __TS__New(Type, message) end}
        )
    end
    local ____initErrorClass_1 = initErrorClass
    local ____class_0 = __TS__Class()
    ____class_0.name = ""
    function ____class_0.prototype.____constructor(self, message)
        if message == nil then
            message = ""
        end
        self.message = message
        self.name = "Error"
        self.stack = getErrorStack(nil, self.constructor.new)
        local metatable = getmetatable(self)
        if metatable and not metatable.__errorToStringPatched then
            metatable.__errorToStringPatched = true
            metatable.__tostring = wrapErrorToString(nil, metatable.__tostring)
        end
    end
    function ____class_0.prototype.__tostring(self)
        return self.message ~= "" and (self.name .. ": ") .. self.message or self.name
    end
    Error = ____initErrorClass_1(nil, ____class_0, "Error")
    local function createErrorClass(self, name)
        local ____initErrorClass_3 = initErrorClass
        local ____class_2 = __TS__Class()
        ____class_2.name = ____class_2.name
        __TS__ClassExtends(____class_2, Error)
        function ____class_2.prototype.____constructor(self, ...)
            ____class_2.____super.prototype.____constructor(self, ...)
            self.name = name
        end
        return ____initErrorClass_3(nil, ____class_2, name)
    end
    RangeError = createErrorClass(nil, "RangeError")
    ReferenceError = createErrorClass(nil, "ReferenceError")
    SyntaxError = createErrorClass(nil, "SyntaxError")
    TypeError = createErrorClass(nil, "TypeError")
    URIError = createErrorClass(nil, "URIError")
end

local function __TS__ObjectAssign(target, ...)
    local sources = {...}
    for i = 1, #sources do
        local source = sources[i]
        for key in pairs(source) do
            target[key] = source[key]
        end
    end
    return target
end

local function __TS__StringSubstring(self, start, ____end)
    if ____end ~= ____end then
        ____end = 0
    end
    if ____end ~= nil and start > ____end then
        start, ____end = ____end, start
    end
    if start >= 0 then
        start = start + 1
    else
        start = 1
    end
    if ____end ~= nil and ____end < 0 then
        ____end = 0
    end
    return string.sub(self, start, ____end)
end

local __TS__ParseInt
do
    local parseIntBasePattern = "0123456789aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTvVwWxXyYzZ"
    function __TS__ParseInt(numberString, base)
        if base == nil then
            base = 10
            local hexMatch = __TS__Match(numberString, "^%s*-?0[xX]")
            if hexMatch ~= nil then
                base = 16
                numberString = (__TS__Match(hexMatch, "-")) and "-" .. __TS__StringSubstring(numberString, #hexMatch) or __TS__StringSubstring(numberString, #hexMatch)
            end
        end
        if base < 2 or base > 36 then
            return 0 / 0
        end
        local allowedDigits = base <= 10 and __TS__StringSubstring(parseIntBasePattern, 0, base) or __TS__StringSubstring(parseIntBasePattern, 0, 10 + 2 * (base - 10))
        local pattern = ("^%s*(-?[" .. allowedDigits) .. "]*)"
        local number = tonumber((__TS__Match(numberString, pattern)), base)
        if number == nil then
            return 0 / 0
        end
        if number >= 0 then
            return math.floor(number)
        else
            return math.ceil(number)
        end
    end
end

local function __TS__ObjectKeys(obj)
    local result = {}
    local len = 0
    for key in pairs(obj) do
        len = len + 1
        result[len] = key
    end
    return result
end

local function __TS__ArrayForEach(self, callbackFn, thisArg)
    for i = 1, #self do
        callbackFn(thisArg, self[i], i - 1, self)
    end
end

local function __TS__ArrayFilter(self, callbackfn, thisArg)
    local result = {}
    local len = 0
    for i = 1, #self do
        if callbackfn(thisArg, self[i], i - 1, self) then
            len = len + 1
            result[len] = self[i]
        end
    end
    return result
end

local __TS__StringSplit
do
    local sub = string.sub
    local find = string.find
    function __TS__StringSplit(source, separator, limit)
        if limit == nil then
            limit = 4294967295
        end
        if limit == 0 then
            return {}
        end
        local result = {}
        local resultIndex = 1
        if separator == nil or separator == "" then
            for i = 1, #source do
                result[resultIndex] = sub(source, i, i)
                resultIndex = resultIndex + 1
            end
        else
            local currentPos = 1
            while resultIndex <= limit do
                local startPos, endPos = find(source, separator, currentPos, true)
                if not startPos then
                    break
                end
                result[resultIndex] = sub(source, currentPos, startPos - 1)
                resultIndex = resultIndex + 1
                currentPos = endPos + 1
            end
            if resultIndex <= limit then
                result[resultIndex] = sub(source, currentPos)
            end
        end
        return result
    end
end

local function __TS__ArraySlice(self, first, last)
    local len = #self
    first = first or 0
    if first < 0 then
        first = len + first
        if first < 0 then
            first = 0
        end
    else
        if first > len then
            first = len
        end
    end
    last = last or len
    if last < 0 then
        last = len + last
        if last < 0 then
            last = 0
        end
    else
        if last > len then
            last = len
        end
    end
    local out = {}
    first = first + 1
    last = last + 1
    local n = 1
    while first < last do
        out[n] = self[first]
        first = first + 1
        n = n + 1
    end
    return out
end

local __TS__Unpack = table.unpack or unpack

local function __TS__StringTrim(self)
    local result = string.gsub(self, "^[%s ﻿]*(.-)[%s ﻿]*$", "%1")
    return result
end

local function __TS__ArrayMap(self, callbackfn, thisArg)
    local result = {}
    for i = 1, #self do
        result[i] = callbackfn(thisArg, self[i], i - 1, self)
    end
    return result
end

local function __TS__ArrayPushArray(self, items)
    local len = #self
    for i = 1, #items do
        len = len + 1
        self[len] = items[i]
    end
    return len
end

local function __TS__Number(value)
    local valueType = type(value)
    if valueType == "number" then
        return value
    elseif valueType == "string" then
        local numberValue = tonumber(value)
        if numberValue then
            return numberValue
        end
        if value == "Infinity" then
            return math.huge
        end
        if value == "-Infinity" then
            return -math.huge
        end
        local stringWithoutSpaces = string.gsub(value, "%s", "")
        if stringWithoutSpaces == "" then
            return 0
        end
        return 0 / 0
    elseif valueType == "boolean" then
        return value and 1 or 0
    else
        return 0 / 0
    end
end

local function __TS__CloneDescriptor(____bindingPattern0)
    local value
    local writable
    local set
    local get
    local configurable
    local enumerable
    enumerable = ____bindingPattern0.enumerable
    configurable = ____bindingPattern0.configurable
    get = ____bindingPattern0.get
    set = ____bindingPattern0.set
    writable = ____bindingPattern0.writable
    value = ____bindingPattern0.value
    local descriptor = {enumerable = enumerable == true, configurable = configurable == true}
    local hasGetterOrSetter = get ~= nil or set ~= nil
    local hasValueOrWritableAttribute = writable ~= nil or value ~= nil
    if hasGetterOrSetter and hasValueOrWritableAttribute then
        error("Invalid property descriptor. Cannot both specify accessors and a value or writable attribute.", 0)
    end
    if get or set then
        descriptor.get = get
        descriptor.set = set
    else
        descriptor.value = value
        descriptor.writable = writable == true
    end
    return descriptor
end

local __TS__SetDescriptor
do
    local function descriptorIndex(self, key)
        local value = rawget(self, key)
        if value ~= nil then
            return value
        end
        local metatable = getmetatable(self)
        while metatable do
            local rawResult = rawget(metatable, key)
            if rawResult ~= nil then
                return rawResult
            end
            local descriptors = rawget(metatable, "_descriptors")
            if descriptors then
                local descriptor = descriptors[key]
                if descriptor ~= nil then
                    if descriptor.get then
                        return descriptor.get(self)
                    end
                    return descriptor.value
                end
            end
            metatable = getmetatable(metatable)
        end
    end
    local function descriptorNewIndex(self, key, value)
        local metatable = getmetatable(self)
        while metatable do
            local descriptors = rawget(metatable, "_descriptors")
            if descriptors then
                local descriptor = descriptors[key]
                if descriptor ~= nil then
                    if descriptor.set then
                        descriptor.set(self, value)
                    else
                        if descriptor.writable == false then
                            error(
                                ((("Cannot assign to read only property '" .. key) .. "' of object '") .. tostring(self)) .. "'",
                                0
                            )
                        end
                        descriptor.value = value
                    end
                    return
                end
            end
            metatable = getmetatable(metatable)
        end
        rawset(self, key, value)
    end
    function __TS__SetDescriptor(target, key, desc, isPrototype)
        if isPrototype == nil then
            isPrototype = false
        end
        local ____isPrototype_0
        if isPrototype then
            ____isPrototype_0 = target
        else
            ____isPrototype_0 = getmetatable(target)
        end
        local metatable = ____isPrototype_0
        if not metatable then
            metatable = {}
            setmetatable(target, metatable)
        end
        local value = rawget(target, key)
        if value ~= nil then
            rawset(target, key, nil)
        end
        if not rawget(metatable, "_descriptors") then
            metatable._descriptors = {}
        end
        metatable._descriptors[key] = __TS__CloneDescriptor(desc)
        metatable.__index = descriptorIndex
        metatable.__newindex = descriptorNewIndex
    end
end

local function __TS__ArrayFind(self, predicate, thisArg)
    for i = 1, #self do
        local elem = self[i]
        if predicate(thisArg, elem, i - 1, self) then
            return elem
        end
    end
    return nil
end

local function __TS__ArraySome(self, callbackfn, thisArg)
    for i = 1, #self do
        if callbackfn(thisArg, self[i], i - 1, self) then
            return true
        end
    end
    return false
end

local function __TS__CountVarargs(...)
    return select("#", ...)
end

local function __TS__SparseArrayNew(...)
    local sparseArray = {...}
    sparseArray.sparseLength = __TS__CountVarargs(...)
    return sparseArray
end

local function __TS__SparseArrayPush(sparseArray, ...)
    local args = {...}
    local argsLen = __TS__CountVarargs(...)
    local listLen = sparseArray.sparseLength
    for i = 1, argsLen do
        sparseArray[listLen + i] = args[i]
    end
    sparseArray.sparseLength = listLen + argsLen
end

local function __TS__SparseArraySpread(sparseArray)
    local _unpack = unpack or table.unpack
    return _unpack(sparseArray, 1, sparseArray.sparseLength)
end

local __TS__Symbol, Symbol
do
    local symbolMetatable = {__tostring = function(self)
        return ("Symbol(" .. (self.description or "")) .. ")"
    end}
    function __TS__Symbol(description)
        return setmetatable({description = description}, symbolMetatable)
    end
    Symbol = {
        asyncDispose = __TS__Symbol("Symbol.asyncDispose"),
        dispose = __TS__Symbol("Symbol.dispose"),
        iterator = __TS__Symbol("Symbol.iterator"),
        hasInstance = __TS__Symbol("Symbol.hasInstance"),
        species = __TS__Symbol("Symbol.species"),
        toStringTag = __TS__Symbol("Symbol.toStringTag")
    }
end

local function __TS__InstanceOf(obj, classTbl)
    if type(classTbl) ~= "table" then
        error("Right-hand side of 'instanceof' is not an object", 0)
    end
    if classTbl[Symbol.hasInstance] ~= nil then
        return not not classTbl[Symbol.hasInstance](classTbl, obj)
    end
    if type(obj) == "table" then
        local luaClass = obj.constructor
        while luaClass ~= nil do
            if luaClass == classTbl then
                return true
            end
            luaClass = luaClass.____super
        end
    end
    return false
end

local function __TS__NumberToFixed(self, fractionDigits)
    if math.abs(self) >= 1e+21 or self ~= self then
        return tostring(self)
    end
    local f = math.floor(fractionDigits or 0)
    if f < 0 or f > 99 then
        error("toFixed() digits argument must be between 0 and 99", 0)
    end
    return string.format(
        ("%." .. tostring(f)) .. "f",
        self
    )
end

return {
  __TS__SourceMapTraceBack = __TS__SourceMapTraceBack,
  __TS__Class = __TS__Class,
  __TS__StringStartsWith = __TS__StringStartsWith,
  Error = Error,
  RangeError = RangeError,
  ReferenceError = ReferenceError,
  SyntaxError = SyntaxError,
  TypeError = TypeError,
  URIError = URIError,
  __TS__New = __TS__New,
  __TS__ObjectAssign = __TS__ObjectAssign,
  __TS__ParseInt = __TS__ParseInt,
  __TS__ObjectKeys = __TS__ObjectKeys,
  __TS__ArrayForEach = __TS__ArrayForEach,
  __TS__ClassExtends = __TS__ClassExtends,
  __TS__ArrayFilter = __TS__ArrayFilter,
  __TS__StringSplit = __TS__StringSplit,
  __TS__ArraySlice = __TS__ArraySlice,
  __TS__Unpack = __TS__Unpack,
  __TS__StringTrim = __TS__StringTrim,
  __TS__ArrayMap = __TS__ArrayMap,
  __TS__ArrayPushArray = __TS__ArrayPushArray,
  __TS__Number = __TS__Number,
  __TS__SetDescriptor = __TS__SetDescriptor,
  __TS__ArrayFind = __TS__ArrayFind,
  __TS__ArraySome = __TS__ArraySome,
  __TS__SparseArrayNew = __TS__SparseArrayNew,
  __TS__SparseArrayPush = __TS__SparseArrayPush,
  __TS__SparseArraySpread = __TS__SparseArraySpread,
  __TS__InstanceOf = __TS__InstanceOf,
  __TS__NumberToFixed = __TS__NumberToFixed
}
 end,
["src.middleware.cors.middleware"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
____exports.corsMiddleware = function(____, req, res, next)
    res:setHeader("Access-Control-Allow-Origin", "*")
    res:setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
    res:setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
    next(nil)
end
return ____exports
 end,
["package"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
return {
    name = "war-room-dcs-server",
    version = "1.0.0",
    description = "War Room DCS Server Component",
    scripts = {
        format = "biome check --apply .",
        ["format:ci"] = "biome ci .",
        prebuild = "ts-json-schema-generator -p src/**/*.dto.ts -o src/dtos/dto.schema.json && node scripts/jsonschema-to-oas31.js",
        test = "vitest run --coverage",
        build = "rimraf dist && tstl -p tsconfig.tstl.json && luamin -f dist/war-room-dcs-server.lua > dist/war-room-dcs-server.min.lua",
        deploy = "node scripts/deploy.js",
        ["build-and-deploy"] = "npm run build && npm run deploy",
        ["tail-log"] = "node scripts/tail.js"
    },
    keywords = {},
    author = "",
    license = "ISC",
    dependencies = {
        ["@flying-dice/tslua-base64"] = "^0.23.0",
        ["@flying-dice/tslua-common"] = "^0.23.0",
        ["@flying-dice/tslua-dcs-types"] = "^0.23.0",
        ["@flying-dice/tslua-http"] = "^0.23.0",
        ["@flying-dice/tslua-http-api"] = "^0.23.0",
        ["@flying-dice/tslua-rxi-json"] = "^0.23.0",
        ["@turf/helpers"] = "^6.5.0"
    },
    devDependencies = {
        ["@biomejs/biome"] = "^1.4.1",
        ["@vitest/coverage-v8"] = "^0.34.6",
        ["lua-types"] = "^2.13.1",
        luamin = "^1.0.4",
        rimraf = "^5.0.5",
        tail = "^2.2.6",
        traverse = "^0.6.7",
        ["ts-json-schema-generator"] = "^1.4.1",
        typescript = "^5.2.2",
        ["typescript-to-lua"] = "^1.22.0",
        vitest = "^0.34.6"
    }
}
 end,
["src.dtos.dto.openapi"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
return {openapi = "3.1.0", info = {title = "DCS War Room Server Components", version = "1.0.0"}, paths = {}, components = {schemas = {
    AirbaseCategory = {enum = {"AIRDROME", "HELIPAD", "SHIP"}, type = "string"},
    AirbaseCategoryDto = {["$ref"] = "#/components/schemas/AirbaseCategory"},
    AirbaseDto = {additionalProperties = false, properties = {
        category = {["$ref"] = "#/components/schemas/AirbaseCategoryDto"},
        coalition = {["$ref"] = "#/components/schemas/CoalitionSideDto"},
        equipment = {["$ref"] = "#/components/schemas/WarehouseEquipmentDto"},
        id = {type = "number"},
        name = {type = "string"},
        position = {["$ref"] = "#/components/schemas/PositionDto"}
    }, required = {
        "id",
        "name",
        "coalition",
        "category",
        "position",
        "equipment"
    }, type = "object"},
    AirplaneGroupTask = {additionalProperties = false, properties = {route = {["$ref"] = "#/components/schemas/LineString"}, speed = {type = "number"}}, required = {"speed", "route"}, type = "object"},
    BBox = {anyOf = {{["$ref"] = "#/components/schemas/BBox2d"}, {["$ref"] = "#/components/schemas/BBox3d"}}},
    BBox2d = {
        description = "Bounding box\n\nhttps://tools.ietf.org/html/rfc7946#section-5 A GeoJSON object MAY have a member named \"bbox\" to include information on the coordinate range for its Geometries, Features, or FeatureCollections. The value of the bbox member MUST be an array of length 2*n where n is the number of dimensions represented in the contained geometries, with all axes of the most southwesterly point followed by all axes of the more northeasterly point. The axes order of a bbox follows the axes order of geometries.",
        items = {type = "number"},
        maxItems = 4,
        minItems = 4,
        type = "array"
    },
    BBox3d = {items = {type = "number"}, maxItems = 6, minItems = 6, type = "array"},
    CoalitionSide = {enum = {"NEUTRAL", "RED", "BLUE"}, type = "string"},
    CoalitionSideDto = {["$ref"] = "#/components/schemas/CoalitionSide"},
    ErrorDto = {additionalProperties = false, properties = {error = {type = "string"}}, required = {"error"}, type = "object"},
    FireAtPositionDto = {additionalProperties = false, properties = {position = {["$ref"] = "#/components/schemas/Position"}}, required = {"position"}, type = "object"},
    GeoJSONObject = {
        additionalProperties = false,
        description = "GeoJSON Object\n\nhttps://tools.ietf.org/html/rfc7946#section-3 The GeoJSON specification also allows [foreign members](https://tools.ietf.org/html/rfc7946#section-6.1) Developers should use \"&\" type in TypeScript or extend the interface to add these foreign members.",
        properties = {bbox = {["$ref"] = "#/components/schemas/BBox", description = "Bounding box of the coordinate range of the object's Geometries, Features, or Feature Collections. https://tools.ietf.org/html/rfc7946#section-5"}, type = {description = "Specifies the type of GeoJSON object.", type = "string"}},
        required = {"type"},
        type = "object"
    },
    GeometryObject = {
        additionalProperties = false,
        description = "Geometry Object\n\nhttps://tools.ietf.org/html/rfc7946#section-3",
        properties = {bbox = {["$ref"] = "#/components/schemas/BBox", description = "Bounding box of the coordinate range of the object's Geometries, Features, or Feature Collections. https://tools.ietf.org/html/rfc7946#section-5"}, type = {["$ref"] = "#/components/schemas/GeometryTypes", description = "Specifies the type of GeoJSON object."}},
        required = {"type"},
        type = "object"
    },
    GeometryTypes = {description = "GeometryTypes\n\nhttps://tools.ietf.org/html/rfc7946#section-1.4 The valid values for the \"type\" property of GeoJSON geometry objects.", enum = {
        "Point",
        "LineString",
        "Polygon",
        "MultiPoint",
        "MultiLineString",
        "MultiPolygon",
        "GeometryCollection"
    }, type = "string"},
    GroundGroupTask = {additionalProperties = false, properties = {route = {["$ref"] = "#/components/schemas/LineString"}, speed = {type = "number"}, useRoads = {type = "boolean"}}, required = {"useRoads", "speed", "route"}, type = "object"},
    GroupCategory = {enum = {
        "SHIP",
        "GROUND",
        "TRAIN",
        "AIRPLANE",
        "HELICOPTER"
    }, type = "string"},
    GroupCategoryDto = {["$ref"] = "#/components/schemas/GroupCategory"},
    GroupDto = {additionalProperties = false, properties = {
        active = {type = "boolean"},
        category = {["$ref"] = "#/components/schemas/GroupCategoryDto"},
        coalition = {["$ref"] = "#/components/schemas/CoalitionSideDto"},
        id = {type = "number"},
        name = {type = "string"},
        size = {type = "number"},
        units = {items = {["$ref"] = "#/components/schemas/UnitDto"}, type = "array"}
    }, required = {
        "id",
        "name",
        "coalition",
        "category",
        "size",
        "units",
        "active"
    }, type = "object"},
    GroupTaskDto = {anyOf = {{["$ref"] = "#/components/schemas/GroundGroupTask"}, {["$ref"] = "#/components/schemas/HelicopterGroupTask"}}},
    HealthDto = {additionalProperties = false, properties = {_APP_VERSION = {type = "string"}, _ARCHITECTURE = {type = "string"}, _VERSION = {type = "string"}, status = {const = "OK", type = "string"}}, required = {"status", "_VERSION", "_APP_VERSION", "_ARCHITECTURE"}, type = "object"},
    HelicopterGroupTask = {additionalProperties = false, properties = {route = {["$ref"] = "#/components/schemas/LineString"}, speed = {type = "number"}}, required = {"speed", "route"}, type = "object"},
    LineString = {
        additionalProperties = false,
        description = "LineString Geometry Object\n\nhttps://tools.ietf.org/html/rfc7946#section-3.1.4",
        properties = {bbox = {["$ref"] = "#/components/schemas/BBox", description = "Bounding box of the coordinate range of the object's Geometries, Features, or Feature Collections. https://tools.ietf.org/html/rfc7946#section-5"}, coordinates = {items = {["$ref"] = "#/components/schemas/Position"}, type = "array"}, type = {const = "LineString", description = "Specifies the type of GeoJSON object.", type = "string"}},
        required = {"coordinates", "type"},
        type = "object"
    },
    LineStringDto = {["$ref"] = "#/components/schemas/LineString", description = "A GeoJSON LineString geometry represented as an array of GeoJSON Positions"},
    OperationResultDto = {additionalProperties = false, properties = {result = {type = "boolean"}}, required = {"result"}, type = "object"},
    Position = {description = "Position\n\nhttps://tools.ietf.org/html/rfc7946#section-3.1.1 Array should contain between two and three elements. The previous GeoJSON specification allowed more elements (e.g., which could be used to represent M values), but the current specification only allows X, Y, and (optionally) Z to be defined.", items = {type = "number"}, type = "array"},
    PositionDto = {["$ref"] = "#/components/schemas/Position", description = "A GeoJSON Position array represented as [longitude, latitude, altitude]"},
    SetCameraDto = {additionalProperties = false, properties = {heading = {description = "The heading of the camera in degrees, with a minimum value of 0 and a maximum value of 360", type = "number"}, pitch = {description = "The pitch of the camera in degrees, with a minimum value of -90 and a maximum value of 90", type = "number"}, position = {["$ref"] = "#/components/schemas/Position"}, roll = {description = "The roll of the camera in degrees, with a minimum value of -180 and a maximum value of 180", type = "number"}}, required = {"position", "heading", "pitch", "roll"}, type = "object"},
    SetTaskDto = {anyOf = {{["$ref"] = "#/components/schemas/GroundGroupTask"}, {["$ref"] = "#/components/schemas/HelicopterGroupTask"}, {["$ref"] = "#/components/schemas/AirplaneGroupTask"}}},
    StartDateMonth = {enum = {
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        9,
        10,
        11,
        12
    }, type = "number"},
    StateDto = {additionalProperties = false, properties = {
        airbases = {items = {["$ref"] = "#/components/schemas/AirbaseDto"}, type = "array"},
        groups = {items = {["$ref"] = "#/components/schemas/GroupDto"}, type = "array"},
        theatre = {type = "string"},
        time = {["$ref"] = "#/components/schemas/TimeDto"},
        timeString = {description = "The time in string format without any timezone information", format = "date-time", type = "string"}
    }, required = {
        "theatre",
        "time",
        "timeString",
        "airbases",
        "groups"
    }, type = "object"},
    TimeDto = {
        additionalProperties = false,
        description = "The time data transfer object",
        properties = {startDate = {
            additionalProperties = false,
            description = "The game world start date in the format of {day, year, month}\n\nFor Example the 1st of January 2021 would be: {day: 1, year: 2021, month: 1}",
            properties = {day = {description = "The day of the month between 1-31", type = "number"}, month = {["$ref"] = "#/components/schemas/StartDateMonth", description = "The month in number between 1 and 12"}, year = {description = "The year in the format of YYYY, this is the absolute year", type = "number"}},
            required = {"day", "year", "month"},
            type = "object"
        }, startTime = {description = "The game world start time in seconds relative to midnight of the mission start date.", type = "number"}, time = {description = "The game world time in seconds relative to time the mission started.\n\nWill always count up from when the mission started.\n\nIf the value is above 86400 then it is the next day after the mission started.\n\nThis function is useful in attaining the time of day", type = "number"}},
        required = {"startDate", "startTime", "time"},
        type = "object"
    },
    UnitCategory = {enum = {
        "GROUND_UNIT",
        "SHIP",
        "STRUCTURE",
        "AIRPLANE",
        "HELICOPTER"
    }, type = "string"},
    UnitCategoryDto = {["$ref"] = "#/components/schemas/UnitCategory"},
    UnitDto = {additionalProperties = false, properties = {
        active = {type = "boolean"},
        ammo = {items = {additionalProperties = false, properties = {count = {type = "number"}, type = {type = "string"}, typeDisplayName = {type = "string"}}, required = {"type", "typeDisplayName", "count"}, type = "object"}, type = "array"},
        category = {["$ref"] = "#/components/schemas/GroupCategoryDto"},
        coalition = {["$ref"] = "#/components/schemas/CoalitionSideDto"},
        fuel = {type = "number"},
        health = {["$ref"] = "#/components/schemas/UnitHealthDto"},
        id = {type = "number"},
        name = {type = "string"},
        position = {["$ref"] = "#/components/schemas/PositionDto"},
        speed = {type = "number"},
        speedMax = {type = "number"},
        threatRange = {type = "number"},
        type = {type = "string"},
        typeDisplayName = {type = "string"}
    }, required = {
        "id",
        "name",
        "coalition",
        "category",
        "type",
        "typeDisplayName",
        "position",
        "health",
        "speedMax",
        "speed",
        "ammo",
        "fuel",
        "active",
        "threatRange"
    }, type = "object"},
    UnitHealthDto = {additionalProperties = false, properties = {current = {type = "number"}, max = {type = "number"}}, required = {"current", "max"}, type = "object"},
    WarehouseEquipment = {additionalProperties = false, properties = {aircraft = {items = {additionalProperties = false, properties = {name = {type = "string"}, quantity = {type = "number"}, type = {type = "string"}}, required = {"quantity", "type", "name"}, type = "object"}, type = "array"}}, required = {"aircraft"}, type = "object"},
    WarehouseEquipmentDto = {["$ref"] = "#/components/schemas/WarehouseEquipment"}
}}}
 end,
["src.openapi.openapi3-ts.model.specification-extension"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local __TS__StringStartsWith = ____lualib.__TS__StringStartsWith
local Error = ____lualib.Error
local RangeError = ____lualib.RangeError
local ReferenceError = ____lualib.ReferenceError
local SyntaxError = ____lualib.SyntaxError
local TypeError = ____lualib.TypeError
local URIError = ____lualib.URIError
local __TS__New = ____lualib.__TS__New
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
____exports.SpecificationExtension = __TS__Class()
local SpecificationExtension = ____exports.SpecificationExtension
SpecificationExtension.name = "SpecificationExtension"
function SpecificationExtension.prototype.____constructor(self)
end
function SpecificationExtension.isValidExtension(self, extensionName)
    return __TS__StringStartsWith(extensionName, "x-")
end
function SpecificationExtension.prototype.getExtension(self, extensionName)
    if not ____exports.SpecificationExtension:isValidExtension(extensionName) then
        error(
            __TS__New(Error, ("Invalid specification extension: '" .. extensionName) .. "'. Extensions must start with prefix 'x-"),
            0
        )
    end
    if self[extensionName] then
        return self[extensionName]
    end
    return nil
end
function SpecificationExtension.prototype.addExtension(self, extensionName, payload)
    if not ____exports.SpecificationExtension:isValidExtension(extensionName) then
        error(
            __TS__New(Error, ("Invalid specification extension: '" .. extensionName) .. "'. Extensions must start with prefix 'x-"),
            0
        )
    end
    self[extensionName] = payload
end
function SpecificationExtension.prototype.listExtensions(self)
    local res = {}
    for propName in pairs(self) do
        if Object.prototype.hasOwnProperty(self, propName) then
            if ____exports.SpecificationExtension:isValidExtension(propName) then
                res[#res + 1] = propName
            end
        end
    end
    return res
end
return ____exports
 end,
["src.openapi.openapi3-ts.model.oas-common"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
local ____specification_2Dextension = require("src.openapi.openapi3-ts.model.specification-extension")
local SpecificationExtension = ____specification_2Dextension.SpecificationExtension
function ____exports.getExtension(self, obj, extensionName)
    if not obj then
        return nil
    end
    if SpecificationExtension:isValidExtension(extensionName) then
        return obj[extensionName]
    end
    return nil
end
function ____exports.addExtension(self, obj, extensionName, extension)
    if obj and SpecificationExtension:isValidExtension(extensionName) then
        obj[extensionName] = extension
    end
end
return ____exports
 end,
["src.openapi.openapi3-ts.model.openapi31"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
local ____specification_2Dextension = require("src.openapi.openapi3-ts.model.specification-extension")
local SpecificationExtension = ____specification_2Dextension.SpecificationExtension
do
    local ____export = require("src.openapi.openapi3-ts.model.oas-common")
    for ____exportKey, ____exportValue in pairs(____export) do
        if ____exportKey ~= "default" then
            ____exports[____exportKey] = ____exportValue
        end
    end
end
function ____exports.getPath(self, pathsObject, path)
    if SpecificationExtension:isValidExtension(path) then
        return nil
    end
    return pathsObject and pathsObject[path] or nil
end
--- A type guard to check if the given value is a `ReferenceObject`.
-- See https://www.typescriptlang.org/docs/handbook/advanced-types.html#type-guards-and-differentiating-types
-- 
-- @param obj The value to check.
function ____exports.isReferenceObject(self, obj)
    return Object.prototype.hasOwnProperty(obj, "$ref")
end
--- A type guard to check if the given object is a `SchemaObject`.
-- Useful to distinguish from `ReferenceObject` values that can be used
-- in most places where `SchemaObject` is allowed.
-- 
-- See https://www.typescriptlang.org/docs/handbook/advanced-types.html#type-guards-and-differentiating-types
-- 
-- @param schema The value to check.
function ____exports.isSchemaObject(self, schema)
    return not Object.prototype.hasOwnProperty(schema, "$ref")
end
return ____exports
 end,
["src.openapi.openapi3-ts.dsl.openapi-builder31"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local __TS__New = ____lualib.__TS__New
local __TS__ObjectAssign = ____lualib.__TS__ObjectAssign
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
____exports.OpenApiBuilder = __TS__Class()
local OpenApiBuilder = ____exports.OpenApiBuilder
OpenApiBuilder.name = "OpenApiBuilder"
function OpenApiBuilder.prototype.____constructor(self, doc)
    self.rootDoc = doc or ({
        openapi = "3.1.0",
        info = {title = "app", version = "version"},
        paths = {},
        components = {
            schemas = {},
            responses = {},
            parameters = {},
            examples = {},
            requestBodies = {},
            headers = {},
            securitySchemes = {},
            links = {},
            callbacks = {}
        },
        tags = {},
        servers = {}
    })
end
function OpenApiBuilder.create(self, doc)
    return __TS__New(____exports.OpenApiBuilder, doc)
end
function OpenApiBuilder.prototype.getSpec(self)
    return self.rootDoc
end
function OpenApiBuilder.prototype.addOpenApiVersion(self, openApiVersion)
    self.rootDoc.openapi = openApiVersion
    return self
end
function OpenApiBuilder.prototype.addInfo(self, info)
    self.rootDoc.info = info
    return self
end
function OpenApiBuilder.prototype.addContact(self, contact)
    self.rootDoc.info.contact = contact
    return self
end
function OpenApiBuilder.prototype.addLicense(self, license)
    self.rootDoc.info.license = license
    return self
end
function OpenApiBuilder.prototype.addTitle(self, title)
    self.rootDoc.info.title = title
    return self
end
function OpenApiBuilder.prototype.addDescription(self, description)
    self.rootDoc.info.description = description
    return self
end
function OpenApiBuilder.prototype.addTermsOfService(self, termsOfService)
    self.rootDoc.info.termsOfService = termsOfService
    return self
end
function OpenApiBuilder.prototype.addVersion(self, version)
    self.rootDoc.info.version = version
    return self
end
function OpenApiBuilder.prototype.addPath(self, path, pathItem)
    self.rootDoc.paths = self.rootDoc.paths or ({})
    self.rootDoc.paths[path] = __TS__ObjectAssign({}, self.rootDoc.paths[path] or ({}), pathItem)
    return self
end
function OpenApiBuilder.prototype.addSchema(self, name, schema)
    self.rootDoc.components = self.rootDoc.components or ({})
    self.rootDoc.components.schemas = self.rootDoc.components.schemas or ({})
    self.rootDoc.components.schemas[name] = schema
    return self
end
function OpenApiBuilder.prototype.addResponse(self, name, response)
    self.rootDoc.components = self.rootDoc.components or ({})
    self.rootDoc.components.responses = self.rootDoc.components.responses or ({})
    self.rootDoc.components.responses[name] = response
    return self
end
function OpenApiBuilder.prototype.addParameter(self, name, parameter)
    self.rootDoc.components = self.rootDoc.components or ({})
    self.rootDoc.components.parameters = self.rootDoc.components.parameters or ({})
    self.rootDoc.components.parameters[name] = parameter
    return self
end
function OpenApiBuilder.prototype.addExample(self, name, example)
    self.rootDoc.components = self.rootDoc.components or ({})
    self.rootDoc.components.examples = self.rootDoc.components.examples or ({})
    self.rootDoc.components.examples[name] = example
    return self
end
function OpenApiBuilder.prototype.addRequestBody(self, name, reqBody)
    self.rootDoc.components = self.rootDoc.components or ({})
    self.rootDoc.components.requestBodies = self.rootDoc.components.requestBodies or ({})
    self.rootDoc.components.requestBodies[name] = reqBody
    return self
end
function OpenApiBuilder.prototype.addHeader(self, name, header)
    self.rootDoc.components = self.rootDoc.components or ({})
    self.rootDoc.components.headers = self.rootDoc.components.headers or ({})
    self.rootDoc.components.headers[name] = header
    return self
end
function OpenApiBuilder.prototype.addSecurityScheme(self, name, secScheme)
    self.rootDoc.components = self.rootDoc.components or ({})
    self.rootDoc.components.securitySchemes = self.rootDoc.components.securitySchemes or ({})
    self.rootDoc.components.securitySchemes[name] = secScheme
    return self
end
function OpenApiBuilder.prototype.addLink(self, name, link)
    self.rootDoc.components = self.rootDoc.components or ({})
    self.rootDoc.components.links = self.rootDoc.components.links or ({})
    self.rootDoc.components.links[name] = link
    return self
end
function OpenApiBuilder.prototype.addCallback(self, name, callback)
    self.rootDoc.components = self.rootDoc.components or ({})
    self.rootDoc.components.callbacks = self.rootDoc.components.callbacks or ({})
    self.rootDoc.components.callbacks[name] = callback
    return self
end
function OpenApiBuilder.prototype.addServer(self, server)
    self.rootDoc.servers = self.rootDoc.servers or ({})
    local ____self_rootDoc_servers_0 = self.rootDoc.servers
    ____self_rootDoc_servers_0[#____self_rootDoc_servers_0 + 1] = server
    return self
end
function OpenApiBuilder.prototype.addTag(self, tag)
    self.rootDoc.tags = self.rootDoc.tags or ({})
    local ____self_rootDoc_tags_1 = self.rootDoc.tags
    ____self_rootDoc_tags_1[#____self_rootDoc_tags_1 + 1] = tag
    return self
end
function OpenApiBuilder.prototype.addExternalDocs(self, extDoc)
    self.rootDoc.externalDocs = extDoc
    return self
end
function OpenApiBuilder.prototype.addWebhook(self, webhook, webhookItem)
    local ____self_rootDoc_2, ____webhooks_3 = self.rootDoc, "webhooks"
    if ____self_rootDoc_2[____webhooks_3] == nil then
        ____self_rootDoc_2[____webhooks_3] = {}
    end
    self.rootDoc.webhooks[webhook] = webhookItem
    return self
end
return ____exports
 end,
["src.openapi.utils"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__ParseInt = ____lualib.__TS__ParseInt
local __TS__ObjectAssign = ____lualib.__TS__ObjectAssign
local __TS__ObjectKeys = ____lualib.__TS__ObjectKeys
local __TS__ArrayForEach = ____lualib.__TS__ArrayForEach
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
____exports.responses = function(____, responseRefs)
    local res = {}
    __TS__ArrayForEach(
        __TS__ObjectKeys(responseRefs),
        function(____, key)
            local httpStatus = __TS__ParseInt(key)
            local responseRef = responseRefs[httpStatus]
            if not responseRef then
                return
            end
            local response, ref = unpack(responseRef)
            res[tostring(key)] = __TS__ObjectAssign({}, response, {content = {["application/json"] = {schema = {["$ref"] = "#/components/schemas/" .. ref}}}})
        end
    )
    return res
end
____exports.body = function(____, schema) return {content = {["application/json"] = {schema = {["$ref"] = "#/components/schemas/" .. schema}}}} end
return ____exports
 end,
["src.openapi.index"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
local ____package_2Ejson = require("package")
local version = ____package_2Ejson.version
local componentsApiSpec = require("src.dtos.dto.openapi")
local ____openapi_2Dbuilder31 = require("src.openapi.openapi3-ts.dsl.openapi-builder31")
local OpenApiBuilder = ____openapi_2Dbuilder31.OpenApiBuilder
do
    local ____export = require("src.openapi.utils")
    for ____exportKey, ____exportValue in pairs(____export) do
        if ____exportKey ~= "default" then
            ____exports[____exportKey] = ____exportValue
        end
    end
end
____exports.apispec = OpenApiBuilder:create({openapi = "3.1.0", info = {title = "DCS War Room Server", version = version}, paths = {}, components = {schemas = componentsApiSpec.components.schemas}})
return ____exports
 end,
["src.app"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__New = ____lualib.__TS__New
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
local ____tslua_2Dhttp = require("lua_modules.@flying-dice.tslua-http.dist.index")
local HttpStatus = ____tslua_2Dhttp.HttpStatus
local ____tslua_2Dhttp_2Dapi = require("lua_modules.@flying-dice.tslua-http-api.dist.index")
local Application = ____tslua_2Dhttp_2Dapi.Application
local ____cors_2Emiddleware = require("src.middleware.cors.middleware")
local corsMiddleware = ____cors_2Emiddleware.corsMiddleware
local ____openapi = require("src.openapi.index")
local apispec = ____openapi.apispec
____exports.app = __TS__New(Application, WAR_ROOM_ADDRESS or "127.0.0.1", WAR_ROOM_PORT or 1630)
local function apiSpecUrl(self, path)
    local res = string.gsub(path, ":([%w-_]+)", "{%1}")
    return res
end
____exports.app:useGlobalErrorHandler(function(____, err, req, res)
    env.error("Error handling request: " .. tostring(err))
    res:status(HttpStatus.INTERNAL_SERVER_ERROR):json({error = tostring(err)})
end)
function ____exports.GET(self, path, operation, handler)
    apispec:addPath(
        apiSpecUrl(nil, path),
        {get = operation}
    )
    ____exports.app:use(path, corsMiddleware)
    return ____exports.app:get(path, handler)
end
function ____exports.POST(self, path, operation, handler)
    apispec:addPath(
        apiSpecUrl(nil, path),
        {post = operation}
    )
    ____exports.app:use(path, corsMiddleware)
    return ____exports.app:post(path, handler)
end
return ____exports
 end,
["lua_modules.@flying-dice.tslua-http-api.dist.index"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["6"] = 1});
local ____exports = {}
do
    local ____export = require("lua_modules.@flying-dice.tslua-http-api.dist.application")
    for ____exportKey, ____exportValue in pairs(____export) do
        if ____exportKey ~= "default" then
            ____exports[____exportKey] = ____exportValue
        end
    end
end
return ____exports
 end,
["lua_modules.@flying-dice.tslua-http-api.dist.application"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local __TS__New = ____lualib.__TS__New
local __TS__ClassExtends = ____lualib.__TS__ClassExtends
local __TS__ArrayForEach = ____lualib.__TS__ArrayForEach
local __TS__ArrayFilter = ____lualib.__TS__ArrayFilter
local Error = ____lualib.Error
local RangeError = ____lualib.RangeError
local ReferenceError = ____lualib.ReferenceError
local SyntaxError = ____lualib.SyntaxError
local TypeError = ____lualib.TypeError
local URIError = ____lualib.URIError
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["16"] = 1,["17"] = 1,["18"] = 2,["19"] = 5,["20"] = 6,["21"] = 7,["22"] = 9,["23"] = 10,["24"] = 10,["25"] = 10,["27"] = 15,["28"] = 15,["29"] = 15,["30"] = 18,["31"] = 18,["32"] = 16,["33"] = 18,["34"] = 27,["35"] = 28,["36"] = 29,["37"] = 27,["38"] = 40,["39"] = 41,["40"] = 42,["41"] = 43,["42"] = 40,["43"] = 54,["44"] = 55,["45"] = 56,["46"] = 57,["47"] = 54,["48"] = 69,["49"] = 70,["50"] = 71,["51"] = 69,["53"] = 90,["54"] = 90,["55"] = 90,["56"] = 90,["57"] = 106,["58"] = 90,["59"] = 107,["60"] = 107,["61"] = 107,["62"] = 107,["63"] = 107,["64"] = 110,["65"] = 111,["66"] = 112,["67"] = 113,["68"] = 112,["69"] = 106,["70"] = 124,["71"] = 124,["72"] = 125,["73"] = 125,["74"] = 125,["75"] = 126,["77"] = 126,["78"] = 126,["79"] = 125,["80"] = 125,["81"] = 124,["82"] = 130,["83"] = 131,["84"] = 130,["85"] = 139,["86"] = 139,["87"] = 140,["88"] = 140,["89"] = 140,["90"] = 141,["92"] = 141,["93"] = 141,["94"] = 140,["95"] = 140,["96"] = 139,["97"] = 148,["98"] = 148,["99"] = 149,["100"] = 149,["101"] = 149,["102"] = 150,["104"] = 150,["105"] = 150,["106"] = 149,["107"] = 149,["108"] = 148,["109"] = 157,["110"] = 157,["111"] = 158,["112"] = 158,["113"] = 158,["114"] = 159,["116"] = 159,["117"] = 159,["118"] = 158,["119"] = 158,["120"] = 157,["121"] = 166,["122"] = 166,["123"] = 167,["124"] = 167,["125"] = 167,["126"] = 168,["128"] = 168,["129"] = 168,["130"] = 167,["131"] = 167,["132"] = 166,["133"] = 175,["134"] = 175,["135"] = 176,["136"] = 176,["137"] = 176,["138"] = 177,["140"] = 177,["141"] = 177,["142"] = 176,["143"] = 176,["144"] = 175,["145"] = 184,["146"] = 184,["147"] = 185,["148"] = 185,["149"] = 185,["150"] = 186,["152"] = 186,["153"] = 186,["154"] = 185,["155"] = 185,["156"] = 184,["157"] = 196,["158"] = 197,["159"] = 200,["160"] = 200,["161"] = 200,["162"] = 200,["163"] = 205,["164"] = 208,["165"] = 209,["167"] = 212,["170"] = 230,["173"] = 215,["174"] = 215,["175"] = 216,["176"] = 217,["177"] = 218,["178"] = 218,["179"] = 218,["180"] = 218,["181"] = 219,["182"] = 220,["184"] = 222,["186"] = 218,["187"] = 218,["189"] = 215,["190"] = 228,["191"] = 228,["198"] = 233,["199"] = 196});
local ____exports = {}
local ____tslua_2Dcommon = require("lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-common.dist.index")
local Logger = ____tslua_2Dcommon.Logger
local ____tslua_2Dhttp = require("lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-http.dist.index")
local HttpServer = ____tslua_2Dhttp.HttpServer
local HttpStatus = ____tslua_2Dhttp.HttpStatus
local StatusText = ____tslua_2Dhttp.StatusText
local json = require("lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-rxi-json.index")
local ____path = require("lua_modules.@flying-dice.tslua-http-api.dist.path")
local getPathParameters = ____path.getPathParameters
local isMatch = ____path.isMatch
--- A class representing an HTTP response, extending the functionality of HttpResponse.
____exports.AppHttpResponse = __TS__Class()
local AppHttpResponse = ____exports.AppHttpResponse
AppHttpResponse.name = "AppHttpResponse"
function AppHttpResponse.prototype.____constructor(self, res)
    self.res = res
    self.logger = __TS__New(Logger, "AppHttpResponse")
end
function AppHttpResponse.prototype.status(self, status)
    self.res.status = status
    return self
end
function AppHttpResponse.prototype.send(self, data)
    self.res.headers["Content-Type"] = "text/plain"
    self.res.body = data
    return self
end
function AppHttpResponse.prototype.json(self, value)
    self.res.headers["Content-Type"] = "application/json"
    self.res.body = json.encode(value)
    return self
end
function AppHttpResponse.prototype.setHeader(self, key, value)
    self.res.headers[key] = value
    return self
end
--- A class representing a web application, extending the functionality of HttpServer.
____exports.Application = __TS__Class()
local Application = ____exports.Application
Application.name = "Application"
__TS__ClassExtends(Application, HttpServer)
function Application.prototype.____constructor(self, bindAddress, port)
    HttpServer.prototype.____constructor(
        self,
        bindAddress,
        port,
        function(____, req, res) return self:handleRequest(req, res) end
    )
    self.logger = __TS__New(Logger, ____exports.Application.name)
    self.requestHandlers = {}
    self.errorMiddleware = function(____, err, req, res)
        res:status(HttpStatus.INTERNAL_SERVER_ERROR):send(StatusText[HttpStatus.INTERNAL_SERVER_ERROR])
    end
end
function Application.prototype.use(self, route, ...)
    local middleware = {...}
    __TS__ArrayForEach(
        middleware,
        function(____, it)
            local ____self_requestHandlers_0 = self.requestHandlers
            local ____temp_1 = #____self_requestHandlers_0 + 1
            ____self_requestHandlers_0[____temp_1] = {route = route, middleware = it}
            return ____temp_1
        end
    )
end
function Application.prototype.useGlobalErrorHandler(self, middleware)
    self.errorMiddleware = middleware
end
function Application.prototype.get(self, route, ...)
    local middleware = {...}
    __TS__ArrayForEach(
        middleware,
        function(____, it)
            local ____self_requestHandlers_2 = self.requestHandlers
            local ____temp_3 = #____self_requestHandlers_2 + 1
            ____self_requestHandlers_2[____temp_3] = {route = route, middleware = it, method = "GET"}
            return ____temp_3
        end
    )
end
function Application.prototype.put(self, route, ...)
    local middleware = {...}
    __TS__ArrayForEach(
        middleware,
        function(____, it)
            local ____self_requestHandlers_4 = self.requestHandlers
            local ____temp_5 = #____self_requestHandlers_4 + 1
            ____self_requestHandlers_4[____temp_5] = {route = route, middleware = it, method = "PUT"}
            return ____temp_5
        end
    )
end
function Application.prototype.post(self, route, ...)
    local middleware = {...}
    __TS__ArrayForEach(
        middleware,
        function(____, it)
            local ____self_requestHandlers_6 = self.requestHandlers
            local ____temp_7 = #____self_requestHandlers_6 + 1
            ____self_requestHandlers_6[____temp_7] = {route = route, middleware = it, method = "POST"}
            return ____temp_7
        end
    )
end
function Application.prototype.delete(self, route, ...)
    local middleware = {...}
    __TS__ArrayForEach(
        middleware,
        function(____, it)
            local ____self_requestHandlers_8 = self.requestHandlers
            local ____temp_9 = #____self_requestHandlers_8 + 1
            ____self_requestHandlers_8[____temp_9] = {route = route, middleware = it, method = "DELETE"}
            return ____temp_9
        end
    )
end
function Application.prototype.patch(self, route, ...)
    local middleware = {...}
    __TS__ArrayForEach(
        middleware,
        function(____, it)
            local ____self_requestHandlers_10 = self.requestHandlers
            local ____temp_11 = #____self_requestHandlers_10 + 1
            ____self_requestHandlers_10[____temp_11] = {route = route, middleware = it, method = "PATCH"}
            return ____temp_11
        end
    )
end
function Application.prototype.options(self, route, ...)
    local middleware = {...}
    __TS__ArrayForEach(
        middleware,
        function(____, it)
            local ____self_requestHandlers_12 = self.requestHandlers
            local ____temp_13 = #____self_requestHandlers_12 + 1
            ____self_requestHandlers_12[____temp_13] = {route = route, middleware = it, method = "OPTIONS"}
            return ____temp_13
        end
    )
end
function Application.prototype.handleRequest(self, req, res)
    self.logger:debug("Handling Request")
    local stack = __TS__ArrayFilter(
        self.requestHandlers,
        function(____, it) return (not it.method or it.method == req.method) and isMatch(nil, it.route, req.path) end
    )
    self.logger:debug(("Found " .. tostring(#stack)) .. " handlers to process")
    if #stack > 0 then
        res.status = HttpStatus.OK
    end
    local appResponse = __TS__New(____exports.AppHttpResponse, res)
    do
        local function ____catch(e)
            self:errorMiddleware(e, req, appResponse)
        end
        local ____try, ____hasReturned = pcall(function()
            local runStackItem
            runStackItem = function(____, idx)
                if idx < #stack then
                    req.parameters = getPathParameters(nil, stack[idx + 1].route, req.path)
                    stack[idx + 1]:middleware(
                        req,
                        appResponse,
                        function(____, err)
                            if not err then
                                runStackItem(nil, idx + 1)
                            else
                                error(err, 0)
                            end
                        end
                    )
                end
            end
            if #stack > 0 then
                runStackItem(nil, 0)
            end
        end)
        if not ____try then
            ____catch(____hasReturned)
        end
    end
    return appResponse.res
end
return ____exports
 end,
["lua_modules.@flying-dice.tslua-http-api.dist.path"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__New = ____lualib.__TS__New
local __TS__ArrayForEach = ____lualib.__TS__ArrayForEach
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["7"] = 1,["8"] = 1,["9"] = 2,["10"] = 2,["11"] = 4,["20"] = 16,["21"] = 17,["22"] = 18,["23"] = 23,["24"] = 24,["25"] = 16,["26"] = 27,["27"] = 28,["28"] = 30,["29"] = 35,["30"] = 36,["31"] = 27,["32"] = 39,["33"] = 40,["34"] = 40,["35"] = 40,["36"] = 40,["37"] = 42,["38"] = 39,["39"] = 45,["40"] = 46,["41"] = 47,["42"] = 49,["43"] = 50,["44"] = 51,["46"] = 54,["47"] = 45,["48"] = 57,["49"] = 61,["50"] = 62,["51"] = 64,["52"] = 65,["53"] = 67,["54"] = 68,["55"] = 70,["56"] = 70,["57"] = 70,["58"] = 71,["59"] = 75,["60"] = 76,["62"] = 70,["63"] = 70,["64"] = 80,["65"] = 57,["66"] = 83,["67"] = 84,["68"] = 85,["69"] = 86,["70"] = 87,["71"] = 83});
local ____exports = {}
local ____tslua_2Dcommon = require("lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-common.dist.index")
local Logger = ____tslua_2Dcommon.Logger
local ____externals = require("lua_modules.@flying-dice.tslua-http-api.dist.externals")
local _string = ____externals._string
local logger = __TS__New(Logger, "Path")
--- The set of characters considered "safe" in URLs is defined by the URL specifications, specifically RFC 3986.
-- According to this specification, the characters that are safe and do not need to be percent-encoded in the path segment of a URL are:
-- 
-- Alphanumeric characters: A-Z a-z 0-9
-- Unreserved characters: - _ . ~
-- Sub-delimiters: ! $ & ' ( ) * + , ; =
-- 
-- @param route
____exports.gSubPathParamsToPattern = function(____, route)
    logger:debug("Replacing Path Params for Pattern matcher " .. route)
    local result = {_string.gsub(route, ":[%w_]+", "([%%w_%%%%-%%.~!$&'()*+,;=]+)")}
    logger:debug("Replaced Path Params for Pattern matcher " .. result[1])
    return result[1]
end
____exports.gSubEscapeReservedChars = function(____, route)
    logger:debug("Escaping Path matcher " .. route)
    local patternRoute = _string.gsub(route, "([%%w_%%%%-%%.~!$&'()*+,;=])", "%%%1")
    logger:debug("Escaping Path matcher " .. patternRoute)
    return patternRoute
end
____exports.routeToPattern = function(____, route)
    local patternRoute = ____exports.gSubPathParamsToPattern(
        nil,
        ____exports.gSubEscapeReservedChars(nil, route)
    )
    return ("^" .. patternRoute) .. "$"
end
____exports.getParamNames = function(____, route)
    logger:debug("Getting Param names from " .. route)
    local names = {}
    for name in _string.gmatch(route, ":(%w+)") do
        logger:debug(("Adding " .. name) .. " to params array")
        names[#names + 1] = name
    end
    return names
end
____exports.getPathParameters = function(____, route, path)
    logger:debug("Getting Param names")
    local paramNames = ____exports.getParamNames(nil, route)
    logger:debug("Getting Route Pattern")
    local pattern = ____exports.routeToPattern(nil, route)
    logger:debug("Assembling Parameters")
    local matches = {}
    __TS__ArrayForEach(
        {_string.match(path, pattern)},
        function(____, match, idx)
            logger:debug((("Adding Parameter " .. (paramNames[idx + 1] or "nil")) .. " from match ") .. match)
            if paramNames[idx + 1] then
                matches[paramNames[idx + 1]] = match
            end
        end
    )
    return matches
end
____exports.isMatch = function(____, route, path)
    local pattern = ____exports.routeToPattern(nil, route)
    logger:debug(((("checking if \"" .. pattern) .. "\" matches \"") .. path) .. "\"")
    local res = {_string.match(path, pattern)}
    return (res and res[1]) ~= nil
end
return ____exports
 end,
["lua_modules.@flying-dice.tslua-http-api.dist.externals"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["5"] = 1});
local ____exports = {}
____exports._string = {gsub = string.gsub, match = string.match, gmatch = string.gmatch}
return ____exports
 end,
["lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-common.dist.index"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["6"] = 1});
local ____exports = {}
do
    local ____export = require("lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-common.dist.logger")
    for ____exportKey, ____exportValue in pairs(____export) do
        if ____exportKey ~= "default" then
            ____exports[____exportKey] = ____exportValue
        end
    end
end
return ____exports
 end,
["lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-common.dist.logger"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["11"] = 8,["12"] = 9,["13"] = 9,["14"] = 10,["15"] = 10,["16"] = 11,["17"] = 11,["18"] = 12,["19"] = 12,["20"] = 13,["21"] = 13,["22"] = 14,["23"] = 14,["35"] = 50,["36"] = 50,["37"] = 50,["38"] = 61,["39"] = 61,["40"] = 61,["41"] = 73,["42"] = 74,["43"] = 75,["45"] = 73,["46"] = 89,["47"] = 90,["48"] = 91,["50"] = 89,["51"] = 105,["52"] = 106,["53"] = 107,["55"] = 105,["56"] = 121,["57"] = 122,["58"] = 123,["60"] = 121,["61"] = 137,["62"] = 138,["63"] = 139,["65"] = 137,["66"] = 154,["67"] = 154,["68"] = 51,["69"] = 53,["70"] = 53,["71"] = 53,["72"] = 53,["73"] = 53,["74"] = 53,["75"] = 53});
local ____exports = {}
--- LogLevel represents the different severity levels that can be used to log messages.
-- 
-- The levels are TRACE, DEBUG, INFO, WARN, ERROR, and OFF.
-- 
-- OFF is a special level that can be used to disable logging.
____exports.LogLevel = LogLevel or ({})
____exports.LogLevel.TRACE = 10
____exports.LogLevel[____exports.LogLevel.TRACE] = "TRACE"
____exports.LogLevel.DEBUG = 20
____exports.LogLevel[____exports.LogLevel.DEBUG] = "DEBUG"
____exports.LogLevel.INFO = 30
____exports.LogLevel[____exports.LogLevel.INFO] = "INFO"
____exports.LogLevel.WARN = 40
____exports.LogLevel[____exports.LogLevel.WARN] = "WARN"
____exports.LogLevel.ERROR = 50
____exports.LogLevel[____exports.LogLevel.ERROR] = "ERROR"
____exports.LogLevel.OFF = 100
____exports.LogLevel[____exports.LogLevel.OFF] = "OFF"
--- Represents a logger that can be used to log messages with different severity levels.
-- 
-- Change the static level property to change the severity level of messages that are logged.
-- 
-- Change the static transports property to change the way messages are logged.
-- 
-- Use Logger.ignore to ignore a severity level.
-- 
-- @example const logger = new Logger("MyLogger");
-- Logger.level = LogLevel.DEBUG;
-- Logger.transports = { debug: print, info: print, warn: print, error: print };
____exports.Logger = __TS__Class()
local Logger = ____exports.Logger
Logger.name = "Logger"
function Logger.prototype.____constructor(self, name)
    self.name = name
end
function Logger.prototype.trace(self, message)
    if ____exports.Logger.level <= ____exports.LogLevel.TRACE then
        ____exports.Logger.transports:trace((("[TRACE] [" .. self.name) .. "] - ") .. message)
    end
end
function Logger.prototype.debug(self, message)
    if ____exports.Logger.level <= ____exports.LogLevel.DEBUG then
        ____exports.Logger.transports:debug((("[DEBUG] [" .. self.name) .. "] - ") .. message)
    end
end
function Logger.prototype.info(self, message)
    if ____exports.Logger.level <= ____exports.LogLevel.INFO then
        ____exports.Logger.transports:info((("[INFO] [" .. self.name) .. "] - ") .. message)
    end
end
function Logger.prototype.warn(self, message)
    if ____exports.Logger.level <= ____exports.LogLevel.WARN then
        ____exports.Logger.transports:warn((("[WARN] [" .. self.name) .. "] - ") .. message)
    end
end
function Logger.prototype.error(self, message)
    if ____exports.Logger.level <= ____exports.LogLevel.ERROR then
        ____exports.Logger.transports:error((("[ERROR] [" .. self.name) .. "] - ") .. message)
    end
end
function Logger.ignore(self)
end
Logger.level = ____exports.LogLevel.INFO
Logger.transports = {
    trace = ____exports.Logger.ignore,
    debug = ____exports.Logger.ignore,
    info = ____exports.Logger.ignore,
    warn = ____exports.Logger.ignore,
    error = ____exports.Logger.ignore
}
return ____exports
 end,
["lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-rxi-json.index"] = function(...) 
--
-- json.lua
--
-- Copyright (c) 2020 rxi
--
-- Permission is hereby granted, free of charge, to any person obtaining a copy of
-- this software and associated documentation files (the "Software"), to deal in
-- the Software without restriction, including without limitation the rights to
-- use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
-- of the Software, and to permit persons to whom the Software is furnished to do
-- so, subject to the following conditions:
--
-- The above copyright notice and this permission notice shall be included in all
-- copies or substantial portions of the Software.
--
-- THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
-- IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
-- FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
-- AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
-- LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
-- OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
-- SOFTWARE.
--

local json = { _version = "0.1.2" }

-------------------------------------------------------------------------------
-- Encode
-------------------------------------------------------------------------------

local encode

local escape_char_map = {
    [ "\\" ] = "\\",
    [ "\"" ] = "\"",
    [ "\b" ] = "b",
    [ "\f" ] = "f",
    [ "\n" ] = "n",
    [ "\r" ] = "r",
    [ "\t" ] = "t",
}

local escape_char_map_inv = { [ "/" ] = "/" }
for k, v in pairs(escape_char_map) do
    escape_char_map_inv[v] = k
end


local function escape_char(c)
    return "\\" .. (escape_char_map[c] or string.format("u%04x", c:byte()))
end


local function encode_nil(val)
    return "null"
end


local function encode_table(val, stack)
    local res = {}
    stack = stack or {}

    -- Circular reference?
    if stack[val] then error("circular reference") end

    stack[val] = true

    if rawget(val, 1) ~= nil or next(val) == nil then
        -- Treat as array -- check keys are valid and it is not sparse
        local n = 0
        for k in pairs(val) do
            if type(k) ~= "number" then
                error("invalid table: mixed or invalid key types")
            end
            n = n + 1
        end
        if n ~= #val then
            error("invalid table: sparse array")
        end
        -- Encode
        for i, v in ipairs(val) do
            table.insert(res, encode(v, stack))
        end
        stack[val] = nil
        return "[" .. table.concat(res, ",") .. "]"

    else
        -- Treat as an object
        for k, v in pairs(val) do
            if type(k) ~= "string" then
                error("invalid table: mixed or invalid key types")
            end
            table.insert(res, encode(k, stack) .. ":" .. encode(v, stack))
        end
        stack[val] = nil
        return "{" .. table.concat(res, ",") .. "}"
    end
end


local function encode_string(val)
    return '"' .. val:gsub('[%z\1-\31\\"]', escape_char) .. '"'
end


local function encode_number(val)
    -- Check for NaN, -inf and inf
    if val ~= val or val <= -math.huge or val >= math.huge then
        error("unexpected number value '" .. tostring(val) .. "'")
    end
    return string.format("%.14g", val)
end


local type_func_map = {
    [ "nil"     ] = encode_nil,
    [ "table"   ] = encode_table,
    [ "string"  ] = encode_string,
    [ "number"  ] = encode_number,
    [ "boolean" ] = tostring,
}


encode = function(val, stack)
    local t = type(val)
    local f = type_func_map[t]
    if f then
        return f(val, stack)
    end
    error("unexpected type '" .. t .. "'")
end


function json.encode(val)
    return ( encode(val) )
end


-------------------------------------------------------------------------------
-- Decode
-------------------------------------------------------------------------------

local parse

local function create_set(...)
    local res = {}
    for i = 1, select("#", ...) do
        res[ select(i, ...) ] = true
    end
    return res
end

local space_chars   = create_set(" ", "\t", "\r", "\n")
local delim_chars   = create_set(" ", "\t", "\r", "\n", "]", "}", ",")
local escape_chars  = create_set("\\", "/", '"', "b", "f", "n", "r", "t", "u")
local literals      = create_set("true", "false", "null")

local literal_map = {
    [ "true"  ] = true,
    [ "false" ] = false,
    [ "null"  ] = nil,
}


local function next_char(str, idx, set, negate)
    for i = idx, #str do
        if set[str:sub(i, i)] ~= negate then
            return i
        end
    end
    return #str + 1
end


local function decode_error(str, idx, msg)
    local line_count = 1
    local col_count = 1
    for i = 1, idx - 1 do
        col_count = col_count + 1
        if str:sub(i, i) == "\n" then
            line_count = line_count + 1
            col_count = 1
        end
    end
    error( string.format("%s at line %d col %d", msg, line_count, col_count) )
end


local function codepoint_to_utf8(n)
    -- http://scripts.sil.org/cms/scripts/page.php?site_id=nrsi&id=iws-appendixa
    local f = math.floor
    if n <= 0x7f then
        return string.char(n)
    elseif n <= 0x7ff then
        return string.char(f(n / 64) + 192, n % 64 + 128)
    elseif n <= 0xffff then
        return string.char(f(n / 4096) + 224, f(n % 4096 / 64) + 128, n % 64 + 128)
    elseif n <= 0x10ffff then
        return string.char(f(n / 262144) + 240, f(n % 262144 / 4096) + 128,
                f(n % 4096 / 64) + 128, n % 64 + 128)
    end
    error( string.format("invalid unicode codepoint '%x'", n) )
end


local function parse_unicode_escape(s)
    local n1 = tonumber( s:sub(1, 4),  16 )
    local n2 = tonumber( s:sub(7, 10), 16 )
    -- Surrogate pair?
    if n2 then
        return codepoint_to_utf8((n1 - 0xd800) * 0x400 + (n2 - 0xdc00) + 0x10000)
    else
        return codepoint_to_utf8(n1)
    end
end


local function parse_string(str, i)
    local res = ""
    local j = i + 1
    local k = j

    while j <= #str do
        local x = str:byte(j)

        if x < 32 then
            decode_error(str, j, "control character in string")

        elseif x == 92 then -- `\`: Escape
            res = res .. str:sub(k, j - 1)
            j = j + 1
            local c = str:sub(j, j)
            if c == "u" then
                local hex = str:match("^[dD][89aAbB]%x%x\\u%x%x%x%x", j + 1)
                        or str:match("^%x%x%x%x", j + 1)
                        or decode_error(str, j - 1, "invalid unicode escape in string")
                res = res .. parse_unicode_escape(hex)
                j = j + #hex
            else
                if not escape_chars[c] then
                    decode_error(str, j - 1, "invalid escape char '" .. c .. "' in string")
                end
                res = res .. escape_char_map_inv[c]
            end
            k = j + 1

        elseif x == 34 then -- `"`: End of string
            res = res .. str:sub(k, j - 1)
            return res, j + 1
        end

        j = j + 1
    end

    decode_error(str, i, "expected closing quote for string")
end


local function parse_number(str, i)
    local x = next_char(str, i, delim_chars)
    local s = str:sub(i, x - 1)
    local n = tonumber(s)
    if not n then
        decode_error(str, i, "invalid number '" .. s .. "'")
    end
    return n, x
end


local function parse_literal(str, i)
    local x = next_char(str, i, delim_chars)
    local word = str:sub(i, x - 1)
    if not literals[word] then
        decode_error(str, i, "invalid literal '" .. word .. "'")
    end
    return literal_map[word], x
end


local function parse_array(str, i)
    local res = {}
    local n = 1
    i = i + 1
    while 1 do
        local x
        i = next_char(str, i, space_chars, true)
        -- Empty / end of array?
        if str:sub(i, i) == "]" then
            i = i + 1
            break
        end
        -- Read token
        x, i = parse(str, i)
        res[n] = x
        n = n + 1
        -- Next token
        i = next_char(str, i, space_chars, true)
        local chr = str:sub(i, i)
        i = i + 1
        if chr == "]" then break end
        if chr ~= "," then decode_error(str, i, "expected ']' or ','") end
    end
    return res, i
end


local function parse_object(str, i)
    local res = {}
    i = i + 1
    while 1 do
        local key, val
        i = next_char(str, i, space_chars, true)
        -- Empty / end of object?
        if str:sub(i, i) == "}" then
            i = i + 1
            break
        end
        -- Read key
        if str:sub(i, i) ~= '"' then
            decode_error(str, i, "expected string for key")
        end
        key, i = parse(str, i)
        -- Read ':' delimiter
        i = next_char(str, i, space_chars, true)
        if str:sub(i, i) ~= ":" then
            decode_error(str, i, "expected ':' after key")
        end
        i = next_char(str, i + 1, space_chars, true)
        -- Read value
        val, i = parse(str, i)
        -- Set
        res[key] = val
        -- Next token
        i = next_char(str, i, space_chars, true)
        local chr = str:sub(i, i)
        i = i + 1
        if chr == "}" then break end
        if chr ~= "," then decode_error(str, i, "expected '}' or ','") end
    end
    return res, i
end


local char_func_map = {
    [ '"' ] = parse_string,
    [ "0" ] = parse_number,
    [ "1" ] = parse_number,
    [ "2" ] = parse_number,
    [ "3" ] = parse_number,
    [ "4" ] = parse_number,
    [ "5" ] = parse_number,
    [ "6" ] = parse_number,
    [ "7" ] = parse_number,
    [ "8" ] = parse_number,
    [ "9" ] = parse_number,
    [ "-" ] = parse_number,
    [ "t" ] = parse_literal,
    [ "f" ] = parse_literal,
    [ "n" ] = parse_literal,
    [ "[" ] = parse_array,
    [ "{" ] = parse_object,
}


parse = function(str, idx)
    local chr = str:sub(idx, idx)
    local f = char_func_map[chr]
    if f then
        return f(str, idx)
    end
    decode_error(str, idx, "unexpected character '" .. chr .. "'")
end


function json.decode(str)
    if type(str) ~= "string" then
        error("expected argument of type string, got " .. type(str))
    end
    local res, idx = parse(str, next_char(str, 1, space_chars, true))
    idx = next_char(str, idx, space_chars, true)
    if idx <= #str then
        decode_error(str, idx, "trailing garbage")
    end
    return res
end


return json end,
["lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-http.dist.index"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["6"] = 1,["14"] = 2,["15"] = 2,["16"] = 2,["17"] = 2,["18"] = 2});
local ____exports = {}
do
    local ____export = require("lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-http.dist.server")
    for ____exportKey, ____exportValue in pairs(____export) do
        if ____exportKey ~= "default" then
            ____exports[____exportKey] = ____exportValue
        end
    end
end
do
    local ____constants = require("lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-http.dist.constants")
    local HttpStatus = ____constants.HttpStatus
    local StatusText = ____constants.StatusText
    ____exports.HttpStatus = HttpStatus
    ____exports.StatusText = StatusText
end
return ____exports
 end,
["lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-http.dist.constants"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["5"] = 1,["6"] = 2,["7"] = 5,["8"] = 11,["9"] = 11,["10"] = 17,["11"] = 17,["12"] = 23,["13"] = 23,["14"] = 29,["15"] = 29,["16"] = 39,["17"] = 39,["18"] = 45,["19"] = 45,["20"] = 51,["21"] = 51,["22"] = 57,["23"] = 57,["24"] = 63,["25"] = 63,["26"] = 69,["27"] = 69,["28"] = 75,["29"] = 75,["30"] = 81,["31"] = 81,["32"] = 87,["33"] = 87,["34"] = 93,["35"] = 93,["36"] = 99,["37"] = 99,["38"] = 105,["39"] = 105,["40"] = 111,["41"] = 111,["42"] = 118,["43"] = 118,["44"] = 124,["45"] = 124,["46"] = 130,["47"] = 130,["48"] = 136,["49"] = 136,["50"] = 142,["51"] = 142,["52"] = 148,["53"] = 148,["54"] = 154,["55"] = 154,["56"] = 160,["57"] = 160,["58"] = 166,["59"] = 166,["60"] = 172,["61"] = 172,["62"] = 178,["63"] = 178,["64"] = 184,["65"] = 184,["66"] = 190,["67"] = 190,["68"] = 196,["69"] = 196,["70"] = 202,["71"] = 202,["72"] = 208,["73"] = 208,["74"] = 214,["75"] = 214,["76"] = 220,["77"] = 220,["78"] = 226,["79"] = 226,["80"] = 232,["81"] = 232,["82"] = 238,["83"] = 238,["84"] = 244,["85"] = 244,["86"] = 250,["87"] = 250,["88"] = 257,["89"] = 257,["90"] = 263,["91"] = 263,["92"] = 269,["93"] = 269,["94"] = 275,["95"] = 275,["96"] = 281,["97"] = 281,["98"] = 287,["99"] = 287,["100"] = 293,["101"] = 293,["102"] = 299,["103"] = 299,["104"] = 305,["105"] = 305,["106"] = 311,["107"] = 311,["108"] = 317,["109"] = 317,["110"] = 323,["111"] = 323,["112"] = 329,["113"] = 329,["114"] = 335,["115"] = 335,["116"] = 341,["117"] = 341,["118"] = 347,["119"] = 347,["120"] = 353,["121"] = 353,["122"] = 359,["123"] = 359,["124"] = 362,["125"] = 362,["126"] = 362,["127"] = 362,["128"] = 362,["129"] = 362,["130"] = 362,["131"] = 362,["132"] = 362,["133"] = 362,["134"] = 362,["135"] = 362,["136"] = 362,["137"] = 362,["138"] = 362,["139"] = 362,["140"] = 362,["141"] = 362,["142"] = 362,["143"] = 362,["144"] = 362,["145"] = 362,["146"] = 362,["147"] = 362,["148"] = 362,["149"] = 362,["150"] = 362,["151"] = 362,["152"] = 362,["153"] = 362,["154"] = 362,["155"] = 362,["156"] = 362,["157"] = 362,["158"] = 362,["159"] = 362,["160"] = 362,["161"] = 362,["162"] = 362,["163"] = 362,["164"] = 362,["165"] = 362,["166"] = 362,["167"] = 362,["168"] = 362,["169"] = 362,["170"] = 362,["171"] = 362,["172"] = 362,["173"] = 362,["174"] = 362,["175"] = 362,["176"] = 362,["177"] = 362,["178"] = 362,["179"] = 362,["180"] = 362,["181"] = 362,["182"] = 362,["183"] = 362});
local ____exports = {}
____exports.EMPTY_LINE = ""
____exports.CRLF = "\r\n"
____exports.HttpStatus = HttpStatus or ({})
____exports.HttpStatus.CONTINUE = 100
____exports.HttpStatus[____exports.HttpStatus.CONTINUE] = "CONTINUE"
____exports.HttpStatus.SWITCHING_PROTOCOLS = 101
____exports.HttpStatus[____exports.HttpStatus.SWITCHING_PROTOCOLS] = "SWITCHING_PROTOCOLS"
____exports.HttpStatus.PROCESSING = 102
____exports.HttpStatus[____exports.HttpStatus.PROCESSING] = "PROCESSING"
____exports.HttpStatus.EARLY_HINTS = 103
____exports.HttpStatus[____exports.HttpStatus.EARLY_HINTS] = "EARLY_HINTS"
____exports.HttpStatus.OK = 200
____exports.HttpStatus[____exports.HttpStatus.OK] = "OK"
____exports.HttpStatus.CREATED = 201
____exports.HttpStatus[____exports.HttpStatus.CREATED] = "CREATED"
____exports.HttpStatus.ACCEPTED = 202
____exports.HttpStatus[____exports.HttpStatus.ACCEPTED] = "ACCEPTED"
____exports.HttpStatus.NON_AUTHORITATIVE_INFORMATION = 203
____exports.HttpStatus[____exports.HttpStatus.NON_AUTHORITATIVE_INFORMATION] = "NON_AUTHORITATIVE_INFORMATION"
____exports.HttpStatus.NO_CONTENT = 204
____exports.HttpStatus[____exports.HttpStatus.NO_CONTENT] = "NO_CONTENT"
____exports.HttpStatus.RESET_CONTENT = 205
____exports.HttpStatus[____exports.HttpStatus.RESET_CONTENT] = "RESET_CONTENT"
____exports.HttpStatus.PARTIAL_CONTENT = 206
____exports.HttpStatus[____exports.HttpStatus.PARTIAL_CONTENT] = "PARTIAL_CONTENT"
____exports.HttpStatus.MULTI_STATUS = 207
____exports.HttpStatus[____exports.HttpStatus.MULTI_STATUS] = "MULTI_STATUS"
____exports.HttpStatus.MULTIPLE_CHOICES = 300
____exports.HttpStatus[____exports.HttpStatus.MULTIPLE_CHOICES] = "MULTIPLE_CHOICES"
____exports.HttpStatus.MOVED_PERMANENTLY = 301
____exports.HttpStatus[____exports.HttpStatus.MOVED_PERMANENTLY] = "MOVED_PERMANENTLY"
____exports.HttpStatus.MOVED_TEMPORARILY = 302
____exports.HttpStatus[____exports.HttpStatus.MOVED_TEMPORARILY] = "MOVED_TEMPORARILY"
____exports.HttpStatus.SEE_OTHER = 303
____exports.HttpStatus[____exports.HttpStatus.SEE_OTHER] = "SEE_OTHER"
____exports.HttpStatus.NOT_MODIFIED = 304
____exports.HttpStatus[____exports.HttpStatus.NOT_MODIFIED] = "NOT_MODIFIED"
____exports.HttpStatus.USE_PROXY = 305
____exports.HttpStatus[____exports.HttpStatus.USE_PROXY] = "USE_PROXY"
____exports.HttpStatus.TEMPORARY_REDIRECT = 307
____exports.HttpStatus[____exports.HttpStatus.TEMPORARY_REDIRECT] = "TEMPORARY_REDIRECT"
____exports.HttpStatus.PERMANENT_REDIRECT = 308
____exports.HttpStatus[____exports.HttpStatus.PERMANENT_REDIRECT] = "PERMANENT_REDIRECT"
____exports.HttpStatus.BAD_REQUEST = 400
____exports.HttpStatus[____exports.HttpStatus.BAD_REQUEST] = "BAD_REQUEST"
____exports.HttpStatus.UNAUTHORIZED = 401
____exports.HttpStatus[____exports.HttpStatus.UNAUTHORIZED] = "UNAUTHORIZED"
____exports.HttpStatus.PAYMENT_REQUIRED = 402
____exports.HttpStatus[____exports.HttpStatus.PAYMENT_REQUIRED] = "PAYMENT_REQUIRED"
____exports.HttpStatus.FORBIDDEN = 403
____exports.HttpStatus[____exports.HttpStatus.FORBIDDEN] = "FORBIDDEN"
____exports.HttpStatus.NOT_FOUND = 404
____exports.HttpStatus[____exports.HttpStatus.NOT_FOUND] = "NOT_FOUND"
____exports.HttpStatus.METHOD_NOT_ALLOWED = 405
____exports.HttpStatus[____exports.HttpStatus.METHOD_NOT_ALLOWED] = "METHOD_NOT_ALLOWED"
____exports.HttpStatus.NOT_ACCEPTABLE = 406
____exports.HttpStatus[____exports.HttpStatus.NOT_ACCEPTABLE] = "NOT_ACCEPTABLE"
____exports.HttpStatus.PROXY_AUTHENTICATION_REQUIRED = 407
____exports.HttpStatus[____exports.HttpStatus.PROXY_AUTHENTICATION_REQUIRED] = "PROXY_AUTHENTICATION_REQUIRED"
____exports.HttpStatus.REQUEST_TIMEOUT = 408
____exports.HttpStatus[____exports.HttpStatus.REQUEST_TIMEOUT] = "REQUEST_TIMEOUT"
____exports.HttpStatus.CONFLICT = 409
____exports.HttpStatus[____exports.HttpStatus.CONFLICT] = "CONFLICT"
____exports.HttpStatus.GONE = 410
____exports.HttpStatus[____exports.HttpStatus.GONE] = "GONE"
____exports.HttpStatus.LENGTH_REQUIRED = 411
____exports.HttpStatus[____exports.HttpStatus.LENGTH_REQUIRED] = "LENGTH_REQUIRED"
____exports.HttpStatus.PRECONDITION_FAILED = 412
____exports.HttpStatus[____exports.HttpStatus.PRECONDITION_FAILED] = "PRECONDITION_FAILED"
____exports.HttpStatus.REQUEST_TOO_LONG = 413
____exports.HttpStatus[____exports.HttpStatus.REQUEST_TOO_LONG] = "REQUEST_TOO_LONG"
____exports.HttpStatus.REQUEST_URI_TOO_LONG = 414
____exports.HttpStatus[____exports.HttpStatus.REQUEST_URI_TOO_LONG] = "REQUEST_URI_TOO_LONG"
____exports.HttpStatus.UNSUPPORTED_MEDIA_TYPE = 415
____exports.HttpStatus[____exports.HttpStatus.UNSUPPORTED_MEDIA_TYPE] = "UNSUPPORTED_MEDIA_TYPE"
____exports.HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE = 416
____exports.HttpStatus[____exports.HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE] = "REQUESTED_RANGE_NOT_SATISFIABLE"
____exports.HttpStatus.EXPECTATION_FAILED = 417
____exports.HttpStatus[____exports.HttpStatus.EXPECTATION_FAILED] = "EXPECTATION_FAILED"
____exports.HttpStatus.IM_A_TEAPOT = 418
____exports.HttpStatus[____exports.HttpStatus.IM_A_TEAPOT] = "IM_A_TEAPOT"
____exports.HttpStatus.INSUFFICIENT_SPACE_ON_RESOURCE = 419
____exports.HttpStatus[____exports.HttpStatus.INSUFFICIENT_SPACE_ON_RESOURCE] = "INSUFFICIENT_SPACE_ON_RESOURCE"
____exports.HttpStatus.METHOD_FAILURE = 420
____exports.HttpStatus[____exports.HttpStatus.METHOD_FAILURE] = "METHOD_FAILURE"
____exports.HttpStatus.MISDIRECTED_REQUEST = 421
____exports.HttpStatus[____exports.HttpStatus.MISDIRECTED_REQUEST] = "MISDIRECTED_REQUEST"
____exports.HttpStatus.UNPROCESSABLE_ENTITY = 422
____exports.HttpStatus[____exports.HttpStatus.UNPROCESSABLE_ENTITY] = "UNPROCESSABLE_ENTITY"
____exports.HttpStatus.LOCKED = 423
____exports.HttpStatus[____exports.HttpStatus.LOCKED] = "LOCKED"
____exports.HttpStatus.FAILED_DEPENDENCY = 424
____exports.HttpStatus[____exports.HttpStatus.FAILED_DEPENDENCY] = "FAILED_DEPENDENCY"
____exports.HttpStatus.UPGRADE_REQUIRED = 426
____exports.HttpStatus[____exports.HttpStatus.UPGRADE_REQUIRED] = "UPGRADE_REQUIRED"
____exports.HttpStatus.PRECONDITION_REQUIRED = 428
____exports.HttpStatus[____exports.HttpStatus.PRECONDITION_REQUIRED] = "PRECONDITION_REQUIRED"
____exports.HttpStatus.TOO_MANY_REQUESTS = 429
____exports.HttpStatus[____exports.HttpStatus.TOO_MANY_REQUESTS] = "TOO_MANY_REQUESTS"
____exports.HttpStatus.REQUEST_HEADER_FIELDS_TOO_LARGE = 431
____exports.HttpStatus[____exports.HttpStatus.REQUEST_HEADER_FIELDS_TOO_LARGE] = "REQUEST_HEADER_FIELDS_TOO_LARGE"
____exports.HttpStatus.UNAVAILABLE_FOR_LEGAL_REASONS = 451
____exports.HttpStatus[____exports.HttpStatus.UNAVAILABLE_FOR_LEGAL_REASONS] = "UNAVAILABLE_FOR_LEGAL_REASONS"
____exports.HttpStatus.INTERNAL_SERVER_ERROR = 500
____exports.HttpStatus[____exports.HttpStatus.INTERNAL_SERVER_ERROR] = "INTERNAL_SERVER_ERROR"
____exports.HttpStatus.NOT_IMPLEMENTED = 501
____exports.HttpStatus[____exports.HttpStatus.NOT_IMPLEMENTED] = "NOT_IMPLEMENTED"
____exports.HttpStatus.BAD_GATEWAY = 502
____exports.HttpStatus[____exports.HttpStatus.BAD_GATEWAY] = "BAD_GATEWAY"
____exports.HttpStatus.SERVICE_UNAVAILABLE = 503
____exports.HttpStatus[____exports.HttpStatus.SERVICE_UNAVAILABLE] = "SERVICE_UNAVAILABLE"
____exports.HttpStatus.GATEWAY_TIMEOUT = 504
____exports.HttpStatus[____exports.HttpStatus.GATEWAY_TIMEOUT] = "GATEWAY_TIMEOUT"
____exports.HttpStatus.HTTP_VERSION_NOT_SUPPORTED = 505
____exports.HttpStatus[____exports.HttpStatus.HTTP_VERSION_NOT_SUPPORTED] = "HTTP_VERSION_NOT_SUPPORTED"
____exports.HttpStatus.INSUFFICIENT_STORAGE = 507
____exports.HttpStatus[____exports.HttpStatus.INSUFFICIENT_STORAGE] = "INSUFFICIENT_STORAGE"
____exports.HttpStatus.NETWORK_AUTHENTICATION_REQUIRED = 511
____exports.HttpStatus[____exports.HttpStatus.NETWORK_AUTHENTICATION_REQUIRED] = "NETWORK_AUTHENTICATION_REQUIRED"
____exports.StatusText = {
    [____exports.HttpStatus.CONTINUE] = "Continue",
    [____exports.HttpStatus.SWITCHING_PROTOCOLS] = "Switching protocols",
    [____exports.HttpStatus.PROCESSING] = "Processing",
    [103] = "Early Hints",
    [200] = "OK",
    [201] = "Created",
    [202] = "Accepted",
    [203] = "Non-Authoritative Information",
    [204] = "No Content",
    [205] = "Reset Content",
    [206] = "Partial Content",
    [207] = "Multi-Status",
    [300] = "Multiple Choices",
    [301] = "Moved Permanently",
    [302] = "Found (Previously \"Moved Temporarily\")",
    [303] = "See Other",
    [304] = "Not Modified",
    [305] = "Use Proxy",
    [307] = "Temporary Redirect",
    [308] = "Permanent Redirect",
    [400] = "Bad Request",
    [401] = "Unauthorized",
    [402] = "Payment Required",
    [403] = "Forbidden",
    [404] = "Not Found",
    [405] = "Method Not Allowed",
    [406] = "Not Acceptable",
    [407] = "Proxy Authentication Required",
    [408] = "Request Timeout",
    [409] = "Conflict",
    [410] = "Gone",
    [411] = "Length Required",
    [412] = "Precondition Failed",
    [413] = "Payload Too Large",
    [414] = "URI Too Long",
    [415] = "Unsupported Media Type",
    [416] = "Range Not Satisfiable",
    [417] = "Expectation Failed",
    [418] = "I'm a Teapot",
    [419] = "INSUFFICIENT_SPACE_ON_RESOURCE",
    [420] = "METHOD_FAILURE",
    [421] = "Misdirected Request",
    [422] = "Unprocessable Entity",
    [423] = "Locked",
    [424] = "Failed Dependency",
    [426] = "Upgrade Required",
    [428] = "Precondition Required",
    [429] = "Too Many Requests",
    [431] = "Request Header Fields Too Large",
    [451] = "Unavailable For Legal Reasons",
    [500] = "Internal Server Error",
    [501] = "Not Implemented",
    [502] = "Bad Gateway",
    [503] = "Service Unavailable",
    [504] = "Gateway Timeout",
    [505] = "HTTP Version Not Supported",
    [507] = "Insufficient Storage",
    [511] = "Network Authentication Required"
}
return ____exports
 end,
["lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-http.dist.server"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local __TS__New = ____lualib.__TS__New
local Error = ____lualib.Error
local RangeError = ____lualib.RangeError
local ReferenceError = ____lualib.ReferenceError
local SyntaxError = ____lualib.SyntaxError
local TypeError = ____lualib.TypeError
local URIError = ____lualib.URIError
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["13"] = 1,["14"] = 1,["15"] = 2,["16"] = 4,["17"] = 4,["18"] = 5,["19"] = 5,["20"] = 6,["21"] = 6,["32"] = 26,["33"] = 26,["34"] = 26,["35"] = 42,["36"] = 44,["37"] = 46,["38"] = 48,["39"] = 49,["40"] = 41,["41"] = 52,["42"] = 53,["43"] = 52,["44"] = 64,["45"] = 66,["46"] = 67,["49"] = 72,["52"] = 69,["53"] = 70,["59"] = 74,["60"] = 75,["64"] = 64,["65"] = 92,["66"] = 93,["67"] = 94,["68"] = 95,["69"] = 96,["72"] = 99,["73"] = 100,["74"] = 101,["76"] = 103,["77"] = 104,["79"] = 105,["84"] = 107,["85"] = 109,["86"] = 110,["87"] = 110,["88"] = 110,["89"] = 110,["90"] = 112,["91"] = 113,["92"] = 114,["93"] = 115,["94"] = 119,["95"] = 120,["97"] = 123,["98"] = 124,["99"] = 129,["100"] = 130,["101"] = 132,["102"] = 133,["103"] = 92});
local ____exports = {}
local ____tslua_2Dcommon = require("lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-http.dist.lua_modules.@flying-dice.tslua-common.dist.index")
local Logger = ____tslua_2Dcommon.Logger
local socket = require("socket")
local ____constants = require("lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-http.dist.constants")
local CRLF = ____constants.CRLF
local ____request = require("lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-http.dist.request")
local readRequestHead = ____request.readRequestHead
local ____response = require("lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-http.dist.response")
local assembleResponseString = ____response.assembleResponseString
--- Represents an HTTP server.
-- This class encapsulates the functionality required for creating and
-- managing an HTTP server, including binding to a network address,
-- accepting client connections, and handling client requests.
-- 
-- @example // Example of creating and starting an HttpServer with a handler which returns 200 for all requests
-- const httpServer = new HttpServer('127.0.0.1', 8080, (req, res) => { res.status = 200; return res; });
-- while(true) {
--   httpServer.acceptNextClient();
-- }
____exports.HttpServer = __TS__Class()
local HttpServer = ____exports.HttpServer
HttpServer.name = "HttpServer"
function HttpServer.prototype.____constructor(self, bindAddress, port, handler)
    self.handler = handler
    self.logger = __TS__New(Logger, "HttpServer")
    self.server = socket.bind(bindAddress, port)
    self.server:settimeout(0)
end
function HttpServer.prototype.close(self)
    self.server:close()
end
function HttpServer.prototype.acceptNextClient(self)
    local client = self.server:accept()
    if client then
        do
            local function ____catch(e)
                self.logger:error("Error handling client: " .. tostring(e))
            end
            local ____try, ____hasReturned = pcall(function()
                self.logger:debug("Handling client")
                self:handleClient(client)
            end)
            if not ____try then
                ____catch(____hasReturned)
            end
            do
                self.logger:debug("Closing client")
                client:close()
            end
        end
    end
end
function HttpServer.prototype.handleClient(self, client)
    local requestHeadLines = {}
    local lastReceived
    self.logger:debug("Handling client")
    client:settimeout(2)
    repeat
        do
            local received = client:receive("*l")
            if type(received) == "string" then
                requestHeadLines[#requestHeadLines + 1] = received
            end
            lastReceived = received
            if received == nil then
                error(
                    __TS__New(Error, "Client returned unexpected value, terminating"),
                    0
                )
            end
        end
    until not (lastReceived ~= "")
    self.logger:debug("Received request head")
    local request = readRequestHead(
        nil,
        table.concat(requestHeadLines, CRLF or ",")
    )
    local contentLength = request.headers["Content-Length"]
    local contentLengthNum = tonumber(contentLength)
    if contentLengthNum and contentLengthNum > 0 then
        self.logger:debug("Fetching request body " .. request.headers["Content-Length"])
        client:settimeout(2)
        request.body = client:receive(contentLengthNum)
    end
    self.logger:debug("Handling request")
    local response = self:handler(request, {status = 404, headers = {}})
    self.logger:debug("Assembling response")
    local responseString = assembleResponseString(nil, response)
    self.logger:debug("Sending response")
    client:send(responseString)
end
return ____exports
 end,
["lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-http.dist.response"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__ObjectKeys = ____lualib.__TS__ObjectKeys
local __TS__ArrayForEach = ____lualib.__TS__ArrayForEach
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["7"] = 1,["8"] = 1,["9"] = 1,["10"] = 1,["35"] = 64,["36"] = 65,["37"] = 68,["38"] = 70,["39"] = 70,["40"] = 70,["41"] = 71,["42"] = 70,["43"] = 70,["44"] = 74,["45"] = 76,["46"] = 77,["47"] = 77,["48"] = 77,["49"] = 77,["50"] = 77,["51"] = 77,["52"] = 77,["53"] = 77,["54"] = 77,["56"] = 84,["57"] = 84,["58"] = 84,["59"] = 84,["60"] = 84,["61"] = 84,["62"] = 84,["63"] = 84,["64"] = 84,["66"] = 92,["67"] = 64});
local ____exports = {}
local ____constants = require("lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-http.dist.constants")
local CRLF = ____constants.CRLF
local EMPTY_LINE = ____constants.EMPTY_LINE
local StatusText = ____constants.StatusText
--- Assembles an HTTP response string based on the provided HttpResponse object.
-- 
-- This function constructs a valid HTTP response string using the status code,
-- headers, and body (if provided) from the HttpResponse object. It includes a
-- default server header indicating the server is "Lua HTTP/1.1". If the status
-- code is not recognized, it defaults to "Unknown Status".
-- 
-- @see https ://developer.mozilla.org/en-US/docs/Web/HTTP/Messages
-- @param response - The HttpResponse object containing the necessary
--   information to construct the response string.
--   It must include a status and headers, with an
--   optional body.
-- @returns The complete HTTP response string, ready to be sent over the network.
-- This string includes the start line (status line), headers, and
-- the response body if provided. Each section is separated by CRLF
-- (Carriage Return and Line Feed) characters.
-- @example const response: HttpResponse = {
--     status: 200,
--     body: 'Hello, world!',
--     headers: {
--         'Content-Type': 'text/plain'
--     }
-- };
-- const responseString = assembleResponseString(response);
function ____exports.assembleResponseString(self, response)
    local startLine = (("HTTP/1.1 " .. tostring(response.status)) .. " ") .. (StatusText[response.status] or "Unknown Status")
    local headers = {"Server: Lua HTTP/1.1"}
    __TS__ArrayForEach(
        __TS__ObjectKeys(response.headers),
        function(____, key)
            headers[#headers + 1] = (key .. ": ") .. response.headers[key]
        end
    )
    local responseString
    if response.body then
        responseString = table.concat(
            {
                startLine,
                table.concat(headers, CRLF or ","),
                EMPTY_LINE,
                response.body
            },
            CRLF or ","
        )
    else
        responseString = table.concat(
            {
                startLine,
                table.concat(headers, CRLF or ","),
                EMPTY_LINE,
                EMPTY_LINE
            },
            CRLF or ","
        )
    end
    return responseString
end
return ____exports
 end,
["lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-http.dist.request"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__StringSplit = ____lualib.__TS__StringSplit
local __TS__ArraySlice = ____lualib.__TS__ArraySlice
local __TS__Unpack = ____lualib.__TS__Unpack
local __TS__StringTrim = ____lualib.__TS__StringTrim
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["9"] = 1,["10"] = 1,["11"] = 2,["12"] = 2,["25"] = 61,["26"] = 62,["27"] = 62,["28"] = 62,["29"] = 63,["30"] = 65,["31"] = 65,["32"] = 65,["33"] = 65,["34"] = 65,["35"] = 65,["36"] = 65,["37"] = 65,["38"] = 74,["39"] = 75,["42"] = 76,["43"] = 77,["45"] = 80,["46"] = 61});
local ____exports = {}
local ____constants = require("lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-http.dist.constants")
local CRLF = ____constants.CRLF
local ____query_2Dparams = require("lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-http.dist.query-params")
local getQueryParams = ____query_2Dparams.getQueryParams
--- Parses an HTTP request string and constructs an HttpRequest object.
-- 
-- This function takes a raw HTTP request payload as a string and parses it to
-- construct an HttpRequest object. It splits the request into its constituent
-- parts: start line, headers, and potentially a body.
-- 
-- @see https ://developer.mozilla.org/en-US/docs/Web/HTTP/Messages
-- @param requestPayload - The complete HTTP request payload as a string.
-- @returns The HttpRequest object representing the parsed request.
-- 
-- The function assumes that the request payload follows the standard HTTP request
-- format, with a start line, followed by headers, an empty line, and an optional body.
____exports.readRequestHead = function(____, requestPayload)
    local ____TS__StringSplit_result_0 = __TS__StringSplit(requestPayload, CRLF)
    local startLine = ____TS__StringSplit_result_0[1]
    local headerLines = __TS__ArraySlice(____TS__StringSplit_result_0, 1)
    local method, originalUrl, protocol = __TS__Unpack(__TS__StringSplit(startLine, " "))
    local httpRequest = {
        method = method,
        path = __TS__StringSplit(originalUrl, "?")[1],
        protocol = protocol,
        headers = {},
        originalUrl = originalUrl,
        parameters = getQueryParams(nil, originalUrl)
    }
    for ____, headerLine in ipairs(headerLines) do
        if headerLine == "" then
            break
        end
        local key, value = __TS__Unpack(__TS__StringSplit(headerLine, ":"))
        httpRequest.headers[__TS__StringTrim(key)] = __TS__StringTrim(value)
    end
    return httpRequest
end
return ____exports
 end,
["lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-http.dist.query-params"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__StringSplit = ____lualib.__TS__StringSplit
local __TS__Unpack = ____lualib.__TS__Unpack
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["25"] = 24,["26"] = 25,["27"] = 27,["28"] = 29,["29"] = 30,["30"] = 31,["31"] = 32,["34"] = 36,["35"] = 24});
local ____exports = {}
--- Extracts query parameters from a given URL and returns them as an object.
-- 
-- This function parses the query string part of a URL and converts it into an object
-- where each key-value pair corresponds to a query parameter and its value.
-- 
-- Note:
-- - If the URL does not have query parameters, the function returns an empty object.
-- - The function does not handle array-like query parameters (e.g., "param[]=value1&param[]=value2").
-- - There is no URL validation; if the input is not a string or does not contain valid query parameters,
--   the behavior is undefined.
-- - Special characters in query parameters are not decoded (e.g., "%20" will not be converted to a space).
-- 
-- @see https ://developer.mozilla.org/en-US/docs/Learn/Common_questions/What_is_a_URL
-- @param url - The URL from which to extract the query parameters.
-- @returns An object containing the query parameters as key-value pairs.
-- @example // If the URL is "http://example.com/page?param1=value1&param2=value2"
-- const queryParams = getQueryParams("http://example.com/page?param1=value1&param2=value2");
-- // The function will return: { param1: "value1", param2: "value2" }
function ____exports.getQueryParams(self, url)
    local _, parametersPart = __TS__Unpack(__TS__StringSplit(url, "?"))
    local parameters = {}
    if parametersPart then
        for ____, parameter in ipairs(__TS__StringSplit(parametersPart, "&")) do
            local name, value = __TS__Unpack(__TS__StringSplit(parameter, "="))
            parameters[name] = value
        end
    end
    return parameters
end
return ____exports
 end,
["lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-http.dist.lua_modules.@flying-dice.tslua-common.dist.index"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["6"] = 1});
local ____exports = {}
do
    local ____export = require("lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-http.dist.lua_modules.@flying-dice.tslua-common.dist.logger")
    for ____exportKey, ____exportValue in pairs(____export) do
        if ____exportKey ~= "default" then
            ____exports[____exportKey] = ____exportValue
        end
    end
end
return ____exports
 end,
["lua_modules.@flying-dice.tslua-http-api.dist.lua_modules.@flying-dice.tslua-http.dist.lua_modules.@flying-dice.tslua-common.dist.logger"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["11"] = 8,["12"] = 9,["13"] = 9,["14"] = 10,["15"] = 10,["16"] = 11,["17"] = 11,["18"] = 12,["19"] = 12,["20"] = 13,["21"] = 13,["22"] = 14,["23"] = 14,["35"] = 50,["36"] = 50,["37"] = 50,["38"] = 61,["39"] = 61,["40"] = 61,["41"] = 73,["42"] = 74,["43"] = 75,["45"] = 73,["46"] = 89,["47"] = 90,["48"] = 91,["50"] = 89,["51"] = 105,["52"] = 106,["53"] = 107,["55"] = 105,["56"] = 121,["57"] = 122,["58"] = 123,["60"] = 121,["61"] = 137,["62"] = 138,["63"] = 139,["65"] = 137,["66"] = 154,["67"] = 154,["68"] = 51,["69"] = 53,["70"] = 53,["71"] = 53,["72"] = 53,["73"] = 53,["74"] = 53,["75"] = 53});
local ____exports = {}
--- LogLevel represents the different severity levels that can be used to log messages.
-- 
-- The levels are TRACE, DEBUG, INFO, WARN, ERROR, and OFF.
-- 
-- OFF is a special level that can be used to disable logging.
____exports.LogLevel = LogLevel or ({})
____exports.LogLevel.TRACE = 10
____exports.LogLevel[____exports.LogLevel.TRACE] = "TRACE"
____exports.LogLevel.DEBUG = 20
____exports.LogLevel[____exports.LogLevel.DEBUG] = "DEBUG"
____exports.LogLevel.INFO = 30
____exports.LogLevel[____exports.LogLevel.INFO] = "INFO"
____exports.LogLevel.WARN = 40
____exports.LogLevel[____exports.LogLevel.WARN] = "WARN"
____exports.LogLevel.ERROR = 50
____exports.LogLevel[____exports.LogLevel.ERROR] = "ERROR"
____exports.LogLevel.OFF = 100
____exports.LogLevel[____exports.LogLevel.OFF] = "OFF"
--- Represents a logger that can be used to log messages with different severity levels.
-- 
-- Change the static level property to change the severity level of messages that are logged.
-- 
-- Change the static transports property to change the way messages are logged.
-- 
-- Use Logger.ignore to ignore a severity level.
-- 
-- @example const logger = new Logger("MyLogger");
-- Logger.level = LogLevel.DEBUG;
-- Logger.transports = { debug: print, info: print, warn: print, error: print };
____exports.Logger = __TS__Class()
local Logger = ____exports.Logger
Logger.name = "Logger"
function Logger.prototype.____constructor(self, name)
    self.name = name
end
function Logger.prototype.trace(self, message)
    if ____exports.Logger.level <= ____exports.LogLevel.TRACE then
        ____exports.Logger.transports:trace((("[TRACE] [" .. self.name) .. "] - ") .. message)
    end
end
function Logger.prototype.debug(self, message)
    if ____exports.Logger.level <= ____exports.LogLevel.DEBUG then
        ____exports.Logger.transports:debug((("[DEBUG] [" .. self.name) .. "] - ") .. message)
    end
end
function Logger.prototype.info(self, message)
    if ____exports.Logger.level <= ____exports.LogLevel.INFO then
        ____exports.Logger.transports:info((("[INFO] [" .. self.name) .. "] - ") .. message)
    end
end
function Logger.prototype.warn(self, message)
    if ____exports.Logger.level <= ____exports.LogLevel.WARN then
        ____exports.Logger.transports:warn((("[WARN] [" .. self.name) .. "] - ") .. message)
    end
end
function Logger.prototype.error(self, message)
    if ____exports.Logger.level <= ____exports.LogLevel.ERROR then
        ____exports.Logger.transports:error((("[ERROR] [" .. self.name) .. "] - ") .. message)
    end
end
function Logger.ignore(self)
end
Logger.level = ____exports.LogLevel.INFO
Logger.transports = {
    trace = ____exports.Logger.ignore,
    debug = ____exports.Logger.ignore,
    info = ____exports.Logger.ignore,
    warn = ____exports.Logger.ignore,
    error = ____exports.Logger.ignore
}
return ____exports
 end,
["lua_modules.@flying-dice.tslua-http.dist.index"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["6"] = 1,["14"] = 2,["15"] = 2,["16"] = 2,["17"] = 2,["18"] = 2});
local ____exports = {}
do
    local ____export = require("lua_modules.@flying-dice.tslua-http.dist.server")
    for ____exportKey, ____exportValue in pairs(____export) do
        if ____exportKey ~= "default" then
            ____exports[____exportKey] = ____exportValue
        end
    end
end
do
    local ____constants = require("lua_modules.@flying-dice.tslua-http.dist.constants")
    local HttpStatus = ____constants.HttpStatus
    local StatusText = ____constants.StatusText
    ____exports.HttpStatus = HttpStatus
    ____exports.StatusText = StatusText
end
return ____exports
 end,
["lua_modules.@flying-dice.tslua-http.dist.constants"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["5"] = 1,["6"] = 2,["7"] = 5,["8"] = 11,["9"] = 11,["10"] = 17,["11"] = 17,["12"] = 23,["13"] = 23,["14"] = 29,["15"] = 29,["16"] = 39,["17"] = 39,["18"] = 45,["19"] = 45,["20"] = 51,["21"] = 51,["22"] = 57,["23"] = 57,["24"] = 63,["25"] = 63,["26"] = 69,["27"] = 69,["28"] = 75,["29"] = 75,["30"] = 81,["31"] = 81,["32"] = 87,["33"] = 87,["34"] = 93,["35"] = 93,["36"] = 99,["37"] = 99,["38"] = 105,["39"] = 105,["40"] = 111,["41"] = 111,["42"] = 118,["43"] = 118,["44"] = 124,["45"] = 124,["46"] = 130,["47"] = 130,["48"] = 136,["49"] = 136,["50"] = 142,["51"] = 142,["52"] = 148,["53"] = 148,["54"] = 154,["55"] = 154,["56"] = 160,["57"] = 160,["58"] = 166,["59"] = 166,["60"] = 172,["61"] = 172,["62"] = 178,["63"] = 178,["64"] = 184,["65"] = 184,["66"] = 190,["67"] = 190,["68"] = 196,["69"] = 196,["70"] = 202,["71"] = 202,["72"] = 208,["73"] = 208,["74"] = 214,["75"] = 214,["76"] = 220,["77"] = 220,["78"] = 226,["79"] = 226,["80"] = 232,["81"] = 232,["82"] = 238,["83"] = 238,["84"] = 244,["85"] = 244,["86"] = 250,["87"] = 250,["88"] = 257,["89"] = 257,["90"] = 263,["91"] = 263,["92"] = 269,["93"] = 269,["94"] = 275,["95"] = 275,["96"] = 281,["97"] = 281,["98"] = 287,["99"] = 287,["100"] = 293,["101"] = 293,["102"] = 299,["103"] = 299,["104"] = 305,["105"] = 305,["106"] = 311,["107"] = 311,["108"] = 317,["109"] = 317,["110"] = 323,["111"] = 323,["112"] = 329,["113"] = 329,["114"] = 335,["115"] = 335,["116"] = 341,["117"] = 341,["118"] = 347,["119"] = 347,["120"] = 353,["121"] = 353,["122"] = 359,["123"] = 359,["124"] = 362,["125"] = 362,["126"] = 362,["127"] = 362,["128"] = 362,["129"] = 362,["130"] = 362,["131"] = 362,["132"] = 362,["133"] = 362,["134"] = 362,["135"] = 362,["136"] = 362,["137"] = 362,["138"] = 362,["139"] = 362,["140"] = 362,["141"] = 362,["142"] = 362,["143"] = 362,["144"] = 362,["145"] = 362,["146"] = 362,["147"] = 362,["148"] = 362,["149"] = 362,["150"] = 362,["151"] = 362,["152"] = 362,["153"] = 362,["154"] = 362,["155"] = 362,["156"] = 362,["157"] = 362,["158"] = 362,["159"] = 362,["160"] = 362,["161"] = 362,["162"] = 362,["163"] = 362,["164"] = 362,["165"] = 362,["166"] = 362,["167"] = 362,["168"] = 362,["169"] = 362,["170"] = 362,["171"] = 362,["172"] = 362,["173"] = 362,["174"] = 362,["175"] = 362,["176"] = 362,["177"] = 362,["178"] = 362,["179"] = 362,["180"] = 362,["181"] = 362,["182"] = 362,["183"] = 362});
local ____exports = {}
____exports.EMPTY_LINE = ""
____exports.CRLF = "\r\n"
____exports.HttpStatus = HttpStatus or ({})
____exports.HttpStatus.CONTINUE = 100
____exports.HttpStatus[____exports.HttpStatus.CONTINUE] = "CONTINUE"
____exports.HttpStatus.SWITCHING_PROTOCOLS = 101
____exports.HttpStatus[____exports.HttpStatus.SWITCHING_PROTOCOLS] = "SWITCHING_PROTOCOLS"
____exports.HttpStatus.PROCESSING = 102
____exports.HttpStatus[____exports.HttpStatus.PROCESSING] = "PROCESSING"
____exports.HttpStatus.EARLY_HINTS = 103
____exports.HttpStatus[____exports.HttpStatus.EARLY_HINTS] = "EARLY_HINTS"
____exports.HttpStatus.OK = 200
____exports.HttpStatus[____exports.HttpStatus.OK] = "OK"
____exports.HttpStatus.CREATED = 201
____exports.HttpStatus[____exports.HttpStatus.CREATED] = "CREATED"
____exports.HttpStatus.ACCEPTED = 202
____exports.HttpStatus[____exports.HttpStatus.ACCEPTED] = "ACCEPTED"
____exports.HttpStatus.NON_AUTHORITATIVE_INFORMATION = 203
____exports.HttpStatus[____exports.HttpStatus.NON_AUTHORITATIVE_INFORMATION] = "NON_AUTHORITATIVE_INFORMATION"
____exports.HttpStatus.NO_CONTENT = 204
____exports.HttpStatus[____exports.HttpStatus.NO_CONTENT] = "NO_CONTENT"
____exports.HttpStatus.RESET_CONTENT = 205
____exports.HttpStatus[____exports.HttpStatus.RESET_CONTENT] = "RESET_CONTENT"
____exports.HttpStatus.PARTIAL_CONTENT = 206
____exports.HttpStatus[____exports.HttpStatus.PARTIAL_CONTENT] = "PARTIAL_CONTENT"
____exports.HttpStatus.MULTI_STATUS = 207
____exports.HttpStatus[____exports.HttpStatus.MULTI_STATUS] = "MULTI_STATUS"
____exports.HttpStatus.MULTIPLE_CHOICES = 300
____exports.HttpStatus[____exports.HttpStatus.MULTIPLE_CHOICES] = "MULTIPLE_CHOICES"
____exports.HttpStatus.MOVED_PERMANENTLY = 301
____exports.HttpStatus[____exports.HttpStatus.MOVED_PERMANENTLY] = "MOVED_PERMANENTLY"
____exports.HttpStatus.MOVED_TEMPORARILY = 302
____exports.HttpStatus[____exports.HttpStatus.MOVED_TEMPORARILY] = "MOVED_TEMPORARILY"
____exports.HttpStatus.SEE_OTHER = 303
____exports.HttpStatus[____exports.HttpStatus.SEE_OTHER] = "SEE_OTHER"
____exports.HttpStatus.NOT_MODIFIED = 304
____exports.HttpStatus[____exports.HttpStatus.NOT_MODIFIED] = "NOT_MODIFIED"
____exports.HttpStatus.USE_PROXY = 305
____exports.HttpStatus[____exports.HttpStatus.USE_PROXY] = "USE_PROXY"
____exports.HttpStatus.TEMPORARY_REDIRECT = 307
____exports.HttpStatus[____exports.HttpStatus.TEMPORARY_REDIRECT] = "TEMPORARY_REDIRECT"
____exports.HttpStatus.PERMANENT_REDIRECT = 308
____exports.HttpStatus[____exports.HttpStatus.PERMANENT_REDIRECT] = "PERMANENT_REDIRECT"
____exports.HttpStatus.BAD_REQUEST = 400
____exports.HttpStatus[____exports.HttpStatus.BAD_REQUEST] = "BAD_REQUEST"
____exports.HttpStatus.UNAUTHORIZED = 401
____exports.HttpStatus[____exports.HttpStatus.UNAUTHORIZED] = "UNAUTHORIZED"
____exports.HttpStatus.PAYMENT_REQUIRED = 402
____exports.HttpStatus[____exports.HttpStatus.PAYMENT_REQUIRED] = "PAYMENT_REQUIRED"
____exports.HttpStatus.FORBIDDEN = 403
____exports.HttpStatus[____exports.HttpStatus.FORBIDDEN] = "FORBIDDEN"
____exports.HttpStatus.NOT_FOUND = 404
____exports.HttpStatus[____exports.HttpStatus.NOT_FOUND] = "NOT_FOUND"
____exports.HttpStatus.METHOD_NOT_ALLOWED = 405
____exports.HttpStatus[____exports.HttpStatus.METHOD_NOT_ALLOWED] = "METHOD_NOT_ALLOWED"
____exports.HttpStatus.NOT_ACCEPTABLE = 406
____exports.HttpStatus[____exports.HttpStatus.NOT_ACCEPTABLE] = "NOT_ACCEPTABLE"
____exports.HttpStatus.PROXY_AUTHENTICATION_REQUIRED = 407
____exports.HttpStatus[____exports.HttpStatus.PROXY_AUTHENTICATION_REQUIRED] = "PROXY_AUTHENTICATION_REQUIRED"
____exports.HttpStatus.REQUEST_TIMEOUT = 408
____exports.HttpStatus[____exports.HttpStatus.REQUEST_TIMEOUT] = "REQUEST_TIMEOUT"
____exports.HttpStatus.CONFLICT = 409
____exports.HttpStatus[____exports.HttpStatus.CONFLICT] = "CONFLICT"
____exports.HttpStatus.GONE = 410
____exports.HttpStatus[____exports.HttpStatus.GONE] = "GONE"
____exports.HttpStatus.LENGTH_REQUIRED = 411
____exports.HttpStatus[____exports.HttpStatus.LENGTH_REQUIRED] = "LENGTH_REQUIRED"
____exports.HttpStatus.PRECONDITION_FAILED = 412
____exports.HttpStatus[____exports.HttpStatus.PRECONDITION_FAILED] = "PRECONDITION_FAILED"
____exports.HttpStatus.REQUEST_TOO_LONG = 413
____exports.HttpStatus[____exports.HttpStatus.REQUEST_TOO_LONG] = "REQUEST_TOO_LONG"
____exports.HttpStatus.REQUEST_URI_TOO_LONG = 414
____exports.HttpStatus[____exports.HttpStatus.REQUEST_URI_TOO_LONG] = "REQUEST_URI_TOO_LONG"
____exports.HttpStatus.UNSUPPORTED_MEDIA_TYPE = 415
____exports.HttpStatus[____exports.HttpStatus.UNSUPPORTED_MEDIA_TYPE] = "UNSUPPORTED_MEDIA_TYPE"
____exports.HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE = 416
____exports.HttpStatus[____exports.HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE] = "REQUESTED_RANGE_NOT_SATISFIABLE"
____exports.HttpStatus.EXPECTATION_FAILED = 417
____exports.HttpStatus[____exports.HttpStatus.EXPECTATION_FAILED] = "EXPECTATION_FAILED"
____exports.HttpStatus.IM_A_TEAPOT = 418
____exports.HttpStatus[____exports.HttpStatus.IM_A_TEAPOT] = "IM_A_TEAPOT"
____exports.HttpStatus.INSUFFICIENT_SPACE_ON_RESOURCE = 419
____exports.HttpStatus[____exports.HttpStatus.INSUFFICIENT_SPACE_ON_RESOURCE] = "INSUFFICIENT_SPACE_ON_RESOURCE"
____exports.HttpStatus.METHOD_FAILURE = 420
____exports.HttpStatus[____exports.HttpStatus.METHOD_FAILURE] = "METHOD_FAILURE"
____exports.HttpStatus.MISDIRECTED_REQUEST = 421
____exports.HttpStatus[____exports.HttpStatus.MISDIRECTED_REQUEST] = "MISDIRECTED_REQUEST"
____exports.HttpStatus.UNPROCESSABLE_ENTITY = 422
____exports.HttpStatus[____exports.HttpStatus.UNPROCESSABLE_ENTITY] = "UNPROCESSABLE_ENTITY"
____exports.HttpStatus.LOCKED = 423
____exports.HttpStatus[____exports.HttpStatus.LOCKED] = "LOCKED"
____exports.HttpStatus.FAILED_DEPENDENCY = 424
____exports.HttpStatus[____exports.HttpStatus.FAILED_DEPENDENCY] = "FAILED_DEPENDENCY"
____exports.HttpStatus.UPGRADE_REQUIRED = 426
____exports.HttpStatus[____exports.HttpStatus.UPGRADE_REQUIRED] = "UPGRADE_REQUIRED"
____exports.HttpStatus.PRECONDITION_REQUIRED = 428
____exports.HttpStatus[____exports.HttpStatus.PRECONDITION_REQUIRED] = "PRECONDITION_REQUIRED"
____exports.HttpStatus.TOO_MANY_REQUESTS = 429
____exports.HttpStatus[____exports.HttpStatus.TOO_MANY_REQUESTS] = "TOO_MANY_REQUESTS"
____exports.HttpStatus.REQUEST_HEADER_FIELDS_TOO_LARGE = 431
____exports.HttpStatus[____exports.HttpStatus.REQUEST_HEADER_FIELDS_TOO_LARGE] = "REQUEST_HEADER_FIELDS_TOO_LARGE"
____exports.HttpStatus.UNAVAILABLE_FOR_LEGAL_REASONS = 451
____exports.HttpStatus[____exports.HttpStatus.UNAVAILABLE_FOR_LEGAL_REASONS] = "UNAVAILABLE_FOR_LEGAL_REASONS"
____exports.HttpStatus.INTERNAL_SERVER_ERROR = 500
____exports.HttpStatus[____exports.HttpStatus.INTERNAL_SERVER_ERROR] = "INTERNAL_SERVER_ERROR"
____exports.HttpStatus.NOT_IMPLEMENTED = 501
____exports.HttpStatus[____exports.HttpStatus.NOT_IMPLEMENTED] = "NOT_IMPLEMENTED"
____exports.HttpStatus.BAD_GATEWAY = 502
____exports.HttpStatus[____exports.HttpStatus.BAD_GATEWAY] = "BAD_GATEWAY"
____exports.HttpStatus.SERVICE_UNAVAILABLE = 503
____exports.HttpStatus[____exports.HttpStatus.SERVICE_UNAVAILABLE] = "SERVICE_UNAVAILABLE"
____exports.HttpStatus.GATEWAY_TIMEOUT = 504
____exports.HttpStatus[____exports.HttpStatus.GATEWAY_TIMEOUT] = "GATEWAY_TIMEOUT"
____exports.HttpStatus.HTTP_VERSION_NOT_SUPPORTED = 505
____exports.HttpStatus[____exports.HttpStatus.HTTP_VERSION_NOT_SUPPORTED] = "HTTP_VERSION_NOT_SUPPORTED"
____exports.HttpStatus.INSUFFICIENT_STORAGE = 507
____exports.HttpStatus[____exports.HttpStatus.INSUFFICIENT_STORAGE] = "INSUFFICIENT_STORAGE"
____exports.HttpStatus.NETWORK_AUTHENTICATION_REQUIRED = 511
____exports.HttpStatus[____exports.HttpStatus.NETWORK_AUTHENTICATION_REQUIRED] = "NETWORK_AUTHENTICATION_REQUIRED"
____exports.StatusText = {
    [____exports.HttpStatus.CONTINUE] = "Continue",
    [____exports.HttpStatus.SWITCHING_PROTOCOLS] = "Switching protocols",
    [____exports.HttpStatus.PROCESSING] = "Processing",
    [103] = "Early Hints",
    [200] = "OK",
    [201] = "Created",
    [202] = "Accepted",
    [203] = "Non-Authoritative Information",
    [204] = "No Content",
    [205] = "Reset Content",
    [206] = "Partial Content",
    [207] = "Multi-Status",
    [300] = "Multiple Choices",
    [301] = "Moved Permanently",
    [302] = "Found (Previously \"Moved Temporarily\")",
    [303] = "See Other",
    [304] = "Not Modified",
    [305] = "Use Proxy",
    [307] = "Temporary Redirect",
    [308] = "Permanent Redirect",
    [400] = "Bad Request",
    [401] = "Unauthorized",
    [402] = "Payment Required",
    [403] = "Forbidden",
    [404] = "Not Found",
    [405] = "Method Not Allowed",
    [406] = "Not Acceptable",
    [407] = "Proxy Authentication Required",
    [408] = "Request Timeout",
    [409] = "Conflict",
    [410] = "Gone",
    [411] = "Length Required",
    [412] = "Precondition Failed",
    [413] = "Payload Too Large",
    [414] = "URI Too Long",
    [415] = "Unsupported Media Type",
    [416] = "Range Not Satisfiable",
    [417] = "Expectation Failed",
    [418] = "I'm a Teapot",
    [419] = "INSUFFICIENT_SPACE_ON_RESOURCE",
    [420] = "METHOD_FAILURE",
    [421] = "Misdirected Request",
    [422] = "Unprocessable Entity",
    [423] = "Locked",
    [424] = "Failed Dependency",
    [426] = "Upgrade Required",
    [428] = "Precondition Required",
    [429] = "Too Many Requests",
    [431] = "Request Header Fields Too Large",
    [451] = "Unavailable For Legal Reasons",
    [500] = "Internal Server Error",
    [501] = "Not Implemented",
    [502] = "Bad Gateway",
    [503] = "Service Unavailable",
    [504] = "Gateway Timeout",
    [505] = "HTTP Version Not Supported",
    [507] = "Insufficient Storage",
    [511] = "Network Authentication Required"
}
return ____exports
 end,
["lua_modules.@flying-dice.tslua-http.dist.server"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local __TS__New = ____lualib.__TS__New
local Error = ____lualib.Error
local RangeError = ____lualib.RangeError
local ReferenceError = ____lualib.ReferenceError
local SyntaxError = ____lualib.SyntaxError
local TypeError = ____lualib.TypeError
local URIError = ____lualib.URIError
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["13"] = 1,["14"] = 1,["15"] = 2,["16"] = 4,["17"] = 4,["18"] = 5,["19"] = 5,["20"] = 6,["21"] = 6,["32"] = 26,["33"] = 26,["34"] = 26,["35"] = 42,["36"] = 44,["37"] = 46,["38"] = 48,["39"] = 49,["40"] = 41,["41"] = 52,["42"] = 53,["43"] = 52,["44"] = 64,["45"] = 66,["46"] = 67,["49"] = 72,["52"] = 69,["53"] = 70,["59"] = 74,["60"] = 75,["64"] = 64,["65"] = 92,["66"] = 93,["67"] = 94,["68"] = 95,["69"] = 96,["72"] = 99,["73"] = 100,["74"] = 101,["76"] = 103,["77"] = 104,["79"] = 105,["84"] = 107,["85"] = 109,["86"] = 110,["87"] = 110,["88"] = 110,["89"] = 110,["90"] = 112,["91"] = 113,["92"] = 114,["93"] = 115,["94"] = 119,["95"] = 120,["97"] = 123,["98"] = 124,["99"] = 129,["100"] = 130,["101"] = 132,["102"] = 133,["103"] = 92});
local ____exports = {}
local ____tslua_2Dcommon = require("lua_modules.@flying-dice.tslua-http.dist.lua_modules.@flying-dice.tslua-common.dist.index")
local Logger = ____tslua_2Dcommon.Logger
local socket = require("socket")
local ____constants = require("lua_modules.@flying-dice.tslua-http.dist.constants")
local CRLF = ____constants.CRLF
local ____request = require("lua_modules.@flying-dice.tslua-http.dist.request")
local readRequestHead = ____request.readRequestHead
local ____response = require("lua_modules.@flying-dice.tslua-http.dist.response")
local assembleResponseString = ____response.assembleResponseString
--- Represents an HTTP server.
-- This class encapsulates the functionality required for creating and
-- managing an HTTP server, including binding to a network address,
-- accepting client connections, and handling client requests.
-- 
-- @example // Example of creating and starting an HttpServer with a handler which returns 200 for all requests
-- const httpServer = new HttpServer('127.0.0.1', 8080, (req, res) => { res.status = 200; return res; });
-- while(true) {
--   httpServer.acceptNextClient();
-- }
____exports.HttpServer = __TS__Class()
local HttpServer = ____exports.HttpServer
HttpServer.name = "HttpServer"
function HttpServer.prototype.____constructor(self, bindAddress, port, handler)
    self.handler = handler
    self.logger = __TS__New(Logger, "HttpServer")
    self.server = socket.bind(bindAddress, port)
    self.server:settimeout(0)
end
function HttpServer.prototype.close(self)
    self.server:close()
end
function HttpServer.prototype.acceptNextClient(self)
    local client = self.server:accept()
    if client then
        do
            local function ____catch(e)
                self.logger:error("Error handling client: " .. tostring(e))
            end
            local ____try, ____hasReturned = pcall(function()
                self.logger:debug("Handling client")
                self:handleClient(client)
            end)
            if not ____try then
                ____catch(____hasReturned)
            end
            do
                self.logger:debug("Closing client")
                client:close()
            end
        end
    end
end
function HttpServer.prototype.handleClient(self, client)
    local requestHeadLines = {}
    local lastReceived
    self.logger:debug("Handling client")
    client:settimeout(2)
    repeat
        do
            local received = client:receive("*l")
            if type(received) == "string" then
                requestHeadLines[#requestHeadLines + 1] = received
            end
            lastReceived = received
            if received == nil then
                error(
                    __TS__New(Error, "Client returned unexpected value, terminating"),
                    0
                )
            end
        end
    until not (lastReceived ~= "")
    self.logger:debug("Received request head")
    local request = readRequestHead(
        nil,
        table.concat(requestHeadLines, CRLF or ",")
    )
    local contentLength = request.headers["Content-Length"]
    local contentLengthNum = tonumber(contentLength)
    if contentLengthNum and contentLengthNum > 0 then
        self.logger:debug("Fetching request body " .. request.headers["Content-Length"])
        client:settimeout(2)
        request.body = client:receive(contentLengthNum)
    end
    self.logger:debug("Handling request")
    local response = self:handler(request, {status = 404, headers = {}})
    self.logger:debug("Assembling response")
    local responseString = assembleResponseString(nil, response)
    self.logger:debug("Sending response")
    client:send(responseString)
end
return ____exports
 end,
["lua_modules.@flying-dice.tslua-http.dist.response"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__ObjectKeys = ____lualib.__TS__ObjectKeys
local __TS__ArrayForEach = ____lualib.__TS__ArrayForEach
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["7"] = 1,["8"] = 1,["9"] = 1,["10"] = 1,["35"] = 64,["36"] = 65,["37"] = 68,["38"] = 70,["39"] = 70,["40"] = 70,["41"] = 71,["42"] = 70,["43"] = 70,["44"] = 74,["45"] = 76,["46"] = 77,["47"] = 77,["48"] = 77,["49"] = 77,["50"] = 77,["51"] = 77,["52"] = 77,["53"] = 77,["54"] = 77,["56"] = 84,["57"] = 84,["58"] = 84,["59"] = 84,["60"] = 84,["61"] = 84,["62"] = 84,["63"] = 84,["64"] = 84,["66"] = 92,["67"] = 64});
local ____exports = {}
local ____constants = require("lua_modules.@flying-dice.tslua-http.dist.constants")
local CRLF = ____constants.CRLF
local EMPTY_LINE = ____constants.EMPTY_LINE
local StatusText = ____constants.StatusText
--- Assembles an HTTP response string based on the provided HttpResponse object.
-- 
-- This function constructs a valid HTTP response string using the status code,
-- headers, and body (if provided) from the HttpResponse object. It includes a
-- default server header indicating the server is "Lua HTTP/1.1". If the status
-- code is not recognized, it defaults to "Unknown Status".
-- 
-- @see https ://developer.mozilla.org/en-US/docs/Web/HTTP/Messages
-- @param response - The HttpResponse object containing the necessary
--   information to construct the response string.
--   It must include a status and headers, with an
--   optional body.
-- @returns The complete HTTP response string, ready to be sent over the network.
-- This string includes the start line (status line), headers, and
-- the response body if provided. Each section is separated by CRLF
-- (Carriage Return and Line Feed) characters.
-- @example const response: HttpResponse = {
--     status: 200,
--     body: 'Hello, world!',
--     headers: {
--         'Content-Type': 'text/plain'
--     }
-- };
-- const responseString = assembleResponseString(response);
function ____exports.assembleResponseString(self, response)
    local startLine = (("HTTP/1.1 " .. tostring(response.status)) .. " ") .. (StatusText[response.status] or "Unknown Status")
    local headers = {"Server: Lua HTTP/1.1"}
    __TS__ArrayForEach(
        __TS__ObjectKeys(response.headers),
        function(____, key)
            headers[#headers + 1] = (key .. ": ") .. response.headers[key]
        end
    )
    local responseString
    if response.body then
        responseString = table.concat(
            {
                startLine,
                table.concat(headers, CRLF or ","),
                EMPTY_LINE,
                response.body
            },
            CRLF or ","
        )
    else
        responseString = table.concat(
            {
                startLine,
                table.concat(headers, CRLF or ","),
                EMPTY_LINE,
                EMPTY_LINE
            },
            CRLF or ","
        )
    end
    return responseString
end
return ____exports
 end,
["lua_modules.@flying-dice.tslua-http.dist.request"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__StringSplit = ____lualib.__TS__StringSplit
local __TS__ArraySlice = ____lualib.__TS__ArraySlice
local __TS__Unpack = ____lualib.__TS__Unpack
local __TS__StringTrim = ____lualib.__TS__StringTrim
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["9"] = 1,["10"] = 1,["11"] = 2,["12"] = 2,["25"] = 61,["26"] = 62,["27"] = 62,["28"] = 62,["29"] = 63,["30"] = 65,["31"] = 65,["32"] = 65,["33"] = 65,["34"] = 65,["35"] = 65,["36"] = 65,["37"] = 65,["38"] = 74,["39"] = 75,["42"] = 76,["43"] = 77,["45"] = 80,["46"] = 61});
local ____exports = {}
local ____constants = require("lua_modules.@flying-dice.tslua-http.dist.constants")
local CRLF = ____constants.CRLF
local ____query_2Dparams = require("lua_modules.@flying-dice.tslua-http.dist.query-params")
local getQueryParams = ____query_2Dparams.getQueryParams
--- Parses an HTTP request string and constructs an HttpRequest object.
-- 
-- This function takes a raw HTTP request payload as a string and parses it to
-- construct an HttpRequest object. It splits the request into its constituent
-- parts: start line, headers, and potentially a body.
-- 
-- @see https ://developer.mozilla.org/en-US/docs/Web/HTTP/Messages
-- @param requestPayload - The complete HTTP request payload as a string.
-- @returns The HttpRequest object representing the parsed request.
-- 
-- The function assumes that the request payload follows the standard HTTP request
-- format, with a start line, followed by headers, an empty line, and an optional body.
____exports.readRequestHead = function(____, requestPayload)
    local ____TS__StringSplit_result_0 = __TS__StringSplit(requestPayload, CRLF)
    local startLine = ____TS__StringSplit_result_0[1]
    local headerLines = __TS__ArraySlice(____TS__StringSplit_result_0, 1)
    local method, originalUrl, protocol = __TS__Unpack(__TS__StringSplit(startLine, " "))
    local httpRequest = {
        method = method,
        path = __TS__StringSplit(originalUrl, "?")[1],
        protocol = protocol,
        headers = {},
        originalUrl = originalUrl,
        parameters = getQueryParams(nil, originalUrl)
    }
    for ____, headerLine in ipairs(headerLines) do
        if headerLine == "" then
            break
        end
        local key, value = __TS__Unpack(__TS__StringSplit(headerLine, ":"))
        httpRequest.headers[__TS__StringTrim(key)] = __TS__StringTrim(value)
    end
    return httpRequest
end
return ____exports
 end,
["lua_modules.@flying-dice.tslua-http.dist.query-params"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__StringSplit = ____lualib.__TS__StringSplit
local __TS__Unpack = ____lualib.__TS__Unpack
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["25"] = 24,["26"] = 25,["27"] = 27,["28"] = 29,["29"] = 30,["30"] = 31,["31"] = 32,["34"] = 36,["35"] = 24});
local ____exports = {}
--- Extracts query parameters from a given URL and returns them as an object.
-- 
-- This function parses the query string part of a URL and converts it into an object
-- where each key-value pair corresponds to a query parameter and its value.
-- 
-- Note:
-- - If the URL does not have query parameters, the function returns an empty object.
-- - The function does not handle array-like query parameters (e.g., "param[]=value1&param[]=value2").
-- - There is no URL validation; if the input is not a string or does not contain valid query parameters,
--   the behavior is undefined.
-- - Special characters in query parameters are not decoded (e.g., "%20" will not be converted to a space).
-- 
-- @see https ://developer.mozilla.org/en-US/docs/Learn/Common_questions/What_is_a_URL
-- @param url - The URL from which to extract the query parameters.
-- @returns An object containing the query parameters as key-value pairs.
-- @example // If the URL is "http://example.com/page?param1=value1&param2=value2"
-- const queryParams = getQueryParams("http://example.com/page?param1=value1&param2=value2");
-- // The function will return: { param1: "value1", param2: "value2" }
function ____exports.getQueryParams(self, url)
    local _, parametersPart = __TS__Unpack(__TS__StringSplit(url, "?"))
    local parameters = {}
    if parametersPart then
        for ____, parameter in ipairs(__TS__StringSplit(parametersPart, "&")) do
            local name, value = __TS__Unpack(__TS__StringSplit(parameter, "="))
            parameters[name] = value
        end
    end
    return parameters
end
return ____exports
 end,
["lua_modules.@flying-dice.tslua-http.dist.lua_modules.@flying-dice.tslua-common.dist.index"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["6"] = 1});
local ____exports = {}
do
    local ____export = require("lua_modules.@flying-dice.tslua-http.dist.lua_modules.@flying-dice.tslua-common.dist.logger")
    for ____exportKey, ____exportValue in pairs(____export) do
        if ____exportKey ~= "default" then
            ____exports[____exportKey] = ____exportValue
        end
    end
end
return ____exports
 end,
["lua_modules.@flying-dice.tslua-http.dist.lua_modules.@flying-dice.tslua-common.dist.logger"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["11"] = 8,["12"] = 9,["13"] = 9,["14"] = 10,["15"] = 10,["16"] = 11,["17"] = 11,["18"] = 12,["19"] = 12,["20"] = 13,["21"] = 13,["22"] = 14,["23"] = 14,["35"] = 50,["36"] = 50,["37"] = 50,["38"] = 61,["39"] = 61,["40"] = 61,["41"] = 73,["42"] = 74,["43"] = 75,["45"] = 73,["46"] = 89,["47"] = 90,["48"] = 91,["50"] = 89,["51"] = 105,["52"] = 106,["53"] = 107,["55"] = 105,["56"] = 121,["57"] = 122,["58"] = 123,["60"] = 121,["61"] = 137,["62"] = 138,["63"] = 139,["65"] = 137,["66"] = 154,["67"] = 154,["68"] = 51,["69"] = 53,["70"] = 53,["71"] = 53,["72"] = 53,["73"] = 53,["74"] = 53,["75"] = 53});
local ____exports = {}
--- LogLevel represents the different severity levels that can be used to log messages.
-- 
-- The levels are TRACE, DEBUG, INFO, WARN, ERROR, and OFF.
-- 
-- OFF is a special level that can be used to disable logging.
____exports.LogLevel = LogLevel or ({})
____exports.LogLevel.TRACE = 10
____exports.LogLevel[____exports.LogLevel.TRACE] = "TRACE"
____exports.LogLevel.DEBUG = 20
____exports.LogLevel[____exports.LogLevel.DEBUG] = "DEBUG"
____exports.LogLevel.INFO = 30
____exports.LogLevel[____exports.LogLevel.INFO] = "INFO"
____exports.LogLevel.WARN = 40
____exports.LogLevel[____exports.LogLevel.WARN] = "WARN"
____exports.LogLevel.ERROR = 50
____exports.LogLevel[____exports.LogLevel.ERROR] = "ERROR"
____exports.LogLevel.OFF = 100
____exports.LogLevel[____exports.LogLevel.OFF] = "OFF"
--- Represents a logger that can be used to log messages with different severity levels.
-- 
-- Change the static level property to change the severity level of messages that are logged.
-- 
-- Change the static transports property to change the way messages are logged.
-- 
-- Use Logger.ignore to ignore a severity level.
-- 
-- @example const logger = new Logger("MyLogger");
-- Logger.level = LogLevel.DEBUG;
-- Logger.transports = { debug: print, info: print, warn: print, error: print };
____exports.Logger = __TS__Class()
local Logger = ____exports.Logger
Logger.name = "Logger"
function Logger.prototype.____constructor(self, name)
    self.name = name
end
function Logger.prototype.trace(self, message)
    if ____exports.Logger.level <= ____exports.LogLevel.TRACE then
        ____exports.Logger.transports:trace((("[TRACE] [" .. self.name) .. "] - ") .. message)
    end
end
function Logger.prototype.debug(self, message)
    if ____exports.Logger.level <= ____exports.LogLevel.DEBUG then
        ____exports.Logger.transports:debug((("[DEBUG] [" .. self.name) .. "] - ") .. message)
    end
end
function Logger.prototype.info(self, message)
    if ____exports.Logger.level <= ____exports.LogLevel.INFO then
        ____exports.Logger.transports:info((("[INFO] [" .. self.name) .. "] - ") .. message)
    end
end
function Logger.prototype.warn(self, message)
    if ____exports.Logger.level <= ____exports.LogLevel.WARN then
        ____exports.Logger.transports:warn((("[WARN] [" .. self.name) .. "] - ") .. message)
    end
end
function Logger.prototype.error(self, message)
    if ____exports.Logger.level <= ____exports.LogLevel.ERROR then
        ____exports.Logger.transports:error((("[ERROR] [" .. self.name) .. "] - ") .. message)
    end
end
function Logger.ignore(self)
end
Logger.level = ____exports.LogLevel.INFO
Logger.transports = {
    trace = ____exports.Logger.ignore,
    debug = ____exports.Logger.ignore,
    info = ____exports.Logger.ignore,
    warn = ____exports.Logger.ignore,
    error = ____exports.Logger.ignore
}
return ____exports
 end,
["src.routes.api-docs"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
local ____app = require("src.app")
local app = ____app.app
local ____openapi = require("src.openapi.index")
local apispec = ____openapi.apispec
app:get(
    "/v3/api-docs",
    function(____, req, res)
        res:json(apispec:getSpec())
    end
)
return ____exports
 end,
["src.dtos.set-camera.dto"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.functions.vectors"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
____exports.vec3ToVec2 = function(____, vec3)
    local ____vec3_0 = vec3
    local x = ____vec3_0.x
    local y = ____vec3_0.y
    local z = ____vec3_0.z
    return {x = x, y = z}
end
return ____exports
 end,
["src.services.geo.service"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local __TS__ArrayMap = ____lualib.__TS__ArrayMap
local __TS__ArrayPushArray = ____lualib.__TS__ArrayPushArray
local __TS__ArrayForEach = ____lualib.__TS__ArrayForEach
local __TS__New = ____lualib.__TS__New
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
local ____vectors = require("src.functions.vectors")
local vec3ToVec2 = ____vectors.vec3ToVec2
____exports.GeoService = __TS__Class()
local GeoService = ____exports.GeoService
GeoService.name = "GeoService"
function GeoService.prototype.____constructor(self)
end
function GeoService.prototype.vec3ToPosition(self, vec3)
    local lat, lon, alt = coord.LOtoLL(vec3)
    return {lon, lat, alt}
end
function GeoService.prototype.positionToVec3(self, pos)
    return coord.LLtoLO(pos[2], pos[1], pos[3])
end
function GeoService.prototype.vec2ToPosition(self, vec2)
    return self:vec3ToPosition({x = vec2.x, y = 0, z = vec2.y})
end
function GeoService.prototype.positionToVec2(self, pos)
    return vec3ToVec2(
        nil,
        self:positionToVec3(pos)
    )
end
function GeoService.prototype.getPathOnRoads(self, start, dest)
    local startVec = self:positionToVec2(start)
    local destVec = self:positionToVec2(dest)
    local path = land.findPathOnRoads(
        "roads",
        startVec.x,
        startVec.y,
        destVec.x,
        destVec.y
    )
    return __TS__ArrayMap(
        path,
        function(____, it) return self:vec2ToPosition(it) end
    )
end
function GeoService.prototype.getRouteOnRoads(self, route)
    local r = {}
    __TS__ArrayForEach(
        route,
        function(____, it, idx)
            if idx == 0 then
                r[#r + 1] = it
            else
                local prev = route[idx]
                __TS__ArrayPushArray(
                    r,
                    self:getPathOnRoads(prev, it)
                )
            end
        end
    )
    r[#r + 1] = route[#route]
    return r
end
function GeoService.prototype.getHeight(self, pos)
    return land.getHeight(self:positionToVec2(pos))
end
____exports.geoService = __TS__New(____exports.GeoService)
return ____exports
 end,
["src.routes.camera"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__New = ____lualib.__TS__New
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
local ____tslua_2Dcommon = require("lua_modules.@flying-dice.tslua-common.dist.index")
local Logger = ____tslua_2Dcommon.Logger
local ____tslua_2Dhttp = require("lua_modules.@flying-dice.tslua-http.dist.index")
local HttpStatus = ____tslua_2Dhttp.HttpStatus
local json = require("lua_modules.@flying-dice.tslua-rxi-json.index")
local ____app = require("src.app")
local POST = ____app.POST
local ____openapi = require("src.openapi.index")
local body = ____openapi.body
local responses = ____openapi.responses
local ____geo_2Eservice = require("src.services.geo.service")
local geoService = ____geo_2Eservice.geoService
local logger = __TS__New(Logger, "camera-router")
local function applyRotation(____, a, b, angle)
    local ax, ay, az, bx, by, bz = a.x, a.y, a.z, b.x, b.y, b.z
    a.x = math.cos(angle) * ax + math.sin(angle) * bx
    a.y = math.cos(angle) * ay + math.sin(angle) * by
    a.z = math.cos(angle) * az + math.sin(angle) * bz
    b.x = math.cos(angle) * bx - math.sin(angle) * ax
    b.y = math.cos(angle) * by - math.sin(angle) * ay
    b.z = math.cos(angle) * bz - math.sin(angle) * az
end
local function getOrientation(____, position, roll, pitch, heading)
    local h = math.rad(heading)
    local p = math.rad(pitch)
    local r = math.rad(roll)
    local o = {x = {x = 1, y = 0, z = 0}, y = {x = 0, y = 1, z = 0}, z = {x = 0, y = 0, z = 1}}
    applyRotation(nil, o.x, o.z, h)
    applyRotation(nil, o.x, o.y, p)
    applyRotation(nil, o.z, o.y, r)
    return o
end
POST(
    nil,
    "/set-camera-position",
    {
        operationId = "setCameraPosition",
        requestBody = body(nil, "SetCameraDto"),
        responses = responses(nil, {[HttpStatus.OK] = {{description = "Result"}, "OperationResultDto"}})
    },
    function(____, req, res)
        logger:info("Setting Camera Position")
        local ____json_decode_result_0 = json.decode(req.body)
        local position = ____json_decode_result_0.position
        local roll = ____json_decode_result_0.roll
        local pitch = ____json_decode_result_0.pitch
        local heading = ____json_decode_result_0.heading
        logger:info("Calculating Vector 3 and new Orientation: " .. json.encode({position = position, roll = roll, pitch = pitch, heading = heading}))
        local vec3 = geoService:positionToVec3(position)
        logger:info("Position: " .. json.encode(position))
        local orientation = getOrientation(
            nil,
            vec3,
            roll,
            pitch,
            heading
        )
        logger:info("Executing Request in server env: " .. json.encode(orientation))
        do
            local function ____catch(e)
                logger:error("Error setting camera position: " .. tostring(e))
                res:status(HttpStatus.INTERNAL_SERVER_ERROR)
                res:json({success = false, error = e})
            end
            local ____try, ____hasReturned = pcall(function()
                local function vec3Str(____, vec3)
                    return ((((("{x=" .. tostring(vec3.x)) .. ",y=") .. tostring(vec3.y)) .. ",z=") .. tostring(vec3.z)) .. "}"
                end
                net.dostring_in(
                    "server",
                    ((((((("Export.LoSetCameraPosition({x=" .. vec3Str(nil, orientation.x)) .. ",y=") .. vec3Str(nil, orientation.y)) .. ",z=") .. vec3Str(nil, orientation.z)) .. ",p=") .. vec3Str(nil, vec3)) .. "})"
                )
            end)
            if not ____try then
                ____catch(____hasReturned)
            end
        end
    end
)
return ____exports
 end,
["lua_modules.@flying-dice.tslua-rxi-json.index"] = function(...) 
--
-- json.lua
--
-- Copyright (c) 2020 rxi
--
-- Permission is hereby granted, free of charge, to any person obtaining a copy of
-- this software and associated documentation files (the "Software"), to deal in
-- the Software without restriction, including without limitation the rights to
-- use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
-- of the Software, and to permit persons to whom the Software is furnished to do
-- so, subject to the following conditions:
--
-- The above copyright notice and this permission notice shall be included in all
-- copies or substantial portions of the Software.
--
-- THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
-- IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
-- FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
-- AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
-- LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
-- OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
-- SOFTWARE.
--

local json = { _version = "0.1.2" }

-------------------------------------------------------------------------------
-- Encode
-------------------------------------------------------------------------------

local encode

local escape_char_map = {
    [ "\\" ] = "\\",
    [ "\"" ] = "\"",
    [ "\b" ] = "b",
    [ "\f" ] = "f",
    [ "\n" ] = "n",
    [ "\r" ] = "r",
    [ "\t" ] = "t",
}

local escape_char_map_inv = { [ "/" ] = "/" }
for k, v in pairs(escape_char_map) do
    escape_char_map_inv[v] = k
end


local function escape_char(c)
    return "\\" .. (escape_char_map[c] or string.format("u%04x", c:byte()))
end


local function encode_nil(val)
    return "null"
end


local function encode_table(val, stack)
    local res = {}
    stack = stack or {}

    -- Circular reference?
    if stack[val] then error("circular reference") end

    stack[val] = true

    if rawget(val, 1) ~= nil or next(val) == nil then
        -- Treat as array -- check keys are valid and it is not sparse
        local n = 0
        for k in pairs(val) do
            if type(k) ~= "number" then
                error("invalid table: mixed or invalid key types")
            end
            n = n + 1
        end
        if n ~= #val then
            error("invalid table: sparse array")
        end
        -- Encode
        for i, v in ipairs(val) do
            table.insert(res, encode(v, stack))
        end
        stack[val] = nil
        return "[" .. table.concat(res, ",") .. "]"

    else
        -- Treat as an object
        for k, v in pairs(val) do
            if type(k) ~= "string" then
                error("invalid table: mixed or invalid key types")
            end
            table.insert(res, encode(k, stack) .. ":" .. encode(v, stack))
        end
        stack[val] = nil
        return "{" .. table.concat(res, ",") .. "}"
    end
end


local function encode_string(val)
    return '"' .. val:gsub('[%z\1-\31\\"]', escape_char) .. '"'
end


local function encode_number(val)
    -- Check for NaN, -inf and inf
    if val ~= val or val <= -math.huge or val >= math.huge then
        error("unexpected number value '" .. tostring(val) .. "'")
    end
    return string.format("%.14g", val)
end


local type_func_map = {
    [ "nil"     ] = encode_nil,
    [ "table"   ] = encode_table,
    [ "string"  ] = encode_string,
    [ "number"  ] = encode_number,
    [ "boolean" ] = tostring,
}


encode = function(val, stack)
    local t = type(val)
    local f = type_func_map[t]
    if f then
        return f(val, stack)
    end
    error("unexpected type '" .. t .. "'")
end


function json.encode(val)
    return ( encode(val) )
end


-------------------------------------------------------------------------------
-- Decode
-------------------------------------------------------------------------------

local parse

local function create_set(...)
    local res = {}
    for i = 1, select("#", ...) do
        res[ select(i, ...) ] = true
    end
    return res
end

local space_chars   = create_set(" ", "\t", "\r", "\n")
local delim_chars   = create_set(" ", "\t", "\r", "\n", "]", "}", ",")
local escape_chars  = create_set("\\", "/", '"', "b", "f", "n", "r", "t", "u")
local literals      = create_set("true", "false", "null")

local literal_map = {
    [ "true"  ] = true,
    [ "false" ] = false,
    [ "null"  ] = nil,
}


local function next_char(str, idx, set, negate)
    for i = idx, #str do
        if set[str:sub(i, i)] ~= negate then
            return i
        end
    end
    return #str + 1
end


local function decode_error(str, idx, msg)
    local line_count = 1
    local col_count = 1
    for i = 1, idx - 1 do
        col_count = col_count + 1
        if str:sub(i, i) == "\n" then
            line_count = line_count + 1
            col_count = 1
        end
    end
    error( string.format("%s at line %d col %d", msg, line_count, col_count) )
end


local function codepoint_to_utf8(n)
    -- http://scripts.sil.org/cms/scripts/page.php?site_id=nrsi&id=iws-appendixa
    local f = math.floor
    if n <= 0x7f then
        return string.char(n)
    elseif n <= 0x7ff then
        return string.char(f(n / 64) + 192, n % 64 + 128)
    elseif n <= 0xffff then
        return string.char(f(n / 4096) + 224, f(n % 4096 / 64) + 128, n % 64 + 128)
    elseif n <= 0x10ffff then
        return string.char(f(n / 262144) + 240, f(n % 262144 / 4096) + 128,
                f(n % 4096 / 64) + 128, n % 64 + 128)
    end
    error( string.format("invalid unicode codepoint '%x'", n) )
end


local function parse_unicode_escape(s)
    local n1 = tonumber( s:sub(1, 4),  16 )
    local n2 = tonumber( s:sub(7, 10), 16 )
    -- Surrogate pair?
    if n2 then
        return codepoint_to_utf8((n1 - 0xd800) * 0x400 + (n2 - 0xdc00) + 0x10000)
    else
        return codepoint_to_utf8(n1)
    end
end


local function parse_string(str, i)
    local res = ""
    local j = i + 1
    local k = j

    while j <= #str do
        local x = str:byte(j)

        if x < 32 then
            decode_error(str, j, "control character in string")

        elseif x == 92 then -- `\`: Escape
            res = res .. str:sub(k, j - 1)
            j = j + 1
            local c = str:sub(j, j)
            if c == "u" then
                local hex = str:match("^[dD][89aAbB]%x%x\\u%x%x%x%x", j + 1)
                        or str:match("^%x%x%x%x", j + 1)
                        or decode_error(str, j - 1, "invalid unicode escape in string")
                res = res .. parse_unicode_escape(hex)
                j = j + #hex
            else
                if not escape_chars[c] then
                    decode_error(str, j - 1, "invalid escape char '" .. c .. "' in string")
                end
                res = res .. escape_char_map_inv[c]
            end
            k = j + 1

        elseif x == 34 then -- `"`: End of string
            res = res .. str:sub(k, j - 1)
            return res, j + 1
        end

        j = j + 1
    end

    decode_error(str, i, "expected closing quote for string")
end


local function parse_number(str, i)
    local x = next_char(str, i, delim_chars)
    local s = str:sub(i, x - 1)
    local n = tonumber(s)
    if not n then
        decode_error(str, i, "invalid number '" .. s .. "'")
    end
    return n, x
end


local function parse_literal(str, i)
    local x = next_char(str, i, delim_chars)
    local word = str:sub(i, x - 1)
    if not literals[word] then
        decode_error(str, i, "invalid literal '" .. word .. "'")
    end
    return literal_map[word], x
end


local function parse_array(str, i)
    local res = {}
    local n = 1
    i = i + 1
    while 1 do
        local x
        i = next_char(str, i, space_chars, true)
        -- Empty / end of array?
        if str:sub(i, i) == "]" then
            i = i + 1
            break
        end
        -- Read token
        x, i = parse(str, i)
        res[n] = x
        n = n + 1
        -- Next token
        i = next_char(str, i, space_chars, true)
        local chr = str:sub(i, i)
        i = i + 1
        if chr == "]" then break end
        if chr ~= "," then decode_error(str, i, "expected ']' or ','") end
    end
    return res, i
end


local function parse_object(str, i)
    local res = {}
    i = i + 1
    while 1 do
        local key, val
        i = next_char(str, i, space_chars, true)
        -- Empty / end of object?
        if str:sub(i, i) == "}" then
            i = i + 1
            break
        end
        -- Read key
        if str:sub(i, i) ~= '"' then
            decode_error(str, i, "expected string for key")
        end
        key, i = parse(str, i)
        -- Read ':' delimiter
        i = next_char(str, i, space_chars, true)
        if str:sub(i, i) ~= ":" then
            decode_error(str, i, "expected ':' after key")
        end
        i = next_char(str, i + 1, space_chars, true)
        -- Read value
        val, i = parse(str, i)
        -- Set
        res[key] = val
        -- Next token
        i = next_char(str, i, space_chars, true)
        local chr = str:sub(i, i)
        i = i + 1
        if chr == "}" then break end
        if chr ~= "," then decode_error(str, i, "expected '}' or ','") end
    end
    return res, i
end


local char_func_map = {
    [ '"' ] = parse_string,
    [ "0" ] = parse_number,
    [ "1" ] = parse_number,
    [ "2" ] = parse_number,
    [ "3" ] = parse_number,
    [ "4" ] = parse_number,
    [ "5" ] = parse_number,
    [ "6" ] = parse_number,
    [ "7" ] = parse_number,
    [ "8" ] = parse_number,
    [ "9" ] = parse_number,
    [ "-" ] = parse_number,
    [ "t" ] = parse_literal,
    [ "f" ] = parse_literal,
    [ "n" ] = parse_literal,
    [ "[" ] = parse_array,
    [ "{" ] = parse_object,
}


parse = function(str, idx)
    local chr = str:sub(idx, idx)
    local f = char_func_map[chr]
    if f then
        return f(str, idx)
    end
    decode_error(str, idx, "unexpected character '" .. chr .. "'")
end


function json.decode(str)
    if type(str) ~= "string" then
        error("expected argument of type string, got " .. type(str))
    end
    local res, idx = parse(str, next_char(str, 1, space_chars, true))
    idx = next_char(str, idx, space_chars, true)
    if idx <= #str then
        decode_error(str, idx, "trailing garbage")
    end
    return res
end


return json end,
["lua_modules.@flying-dice.tslua-common.dist.index"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["6"] = 1});
local ____exports = {}
do
    local ____export = require("lua_modules.@flying-dice.tslua-common.dist.logger")
    for ____exportKey, ____exportValue in pairs(____export) do
        if ____exportKey ~= "default" then
            ____exports[____exportKey] = ____exportValue
        end
    end
end
return ____exports
 end,
["lua_modules.@flying-dice.tslua-common.dist.logger"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["11"] = 8,["12"] = 9,["13"] = 9,["14"] = 10,["15"] = 10,["16"] = 11,["17"] = 11,["18"] = 12,["19"] = 12,["20"] = 13,["21"] = 13,["22"] = 14,["23"] = 14,["35"] = 50,["36"] = 50,["37"] = 50,["38"] = 61,["39"] = 61,["40"] = 61,["41"] = 73,["42"] = 74,["43"] = 75,["45"] = 73,["46"] = 89,["47"] = 90,["48"] = 91,["50"] = 89,["51"] = 105,["52"] = 106,["53"] = 107,["55"] = 105,["56"] = 121,["57"] = 122,["58"] = 123,["60"] = 121,["61"] = 137,["62"] = 138,["63"] = 139,["65"] = 137,["66"] = 154,["67"] = 154,["68"] = 51,["69"] = 53,["70"] = 53,["71"] = 53,["72"] = 53,["73"] = 53,["74"] = 53,["75"] = 53});
local ____exports = {}
--- LogLevel represents the different severity levels that can be used to log messages.
-- 
-- The levels are TRACE, DEBUG, INFO, WARN, ERROR, and OFF.
-- 
-- OFF is a special level that can be used to disable logging.
____exports.LogLevel = LogLevel or ({})
____exports.LogLevel.TRACE = 10
____exports.LogLevel[____exports.LogLevel.TRACE] = "TRACE"
____exports.LogLevel.DEBUG = 20
____exports.LogLevel[____exports.LogLevel.DEBUG] = "DEBUG"
____exports.LogLevel.INFO = 30
____exports.LogLevel[____exports.LogLevel.INFO] = "INFO"
____exports.LogLevel.WARN = 40
____exports.LogLevel[____exports.LogLevel.WARN] = "WARN"
____exports.LogLevel.ERROR = 50
____exports.LogLevel[____exports.LogLevel.ERROR] = "ERROR"
____exports.LogLevel.OFF = 100
____exports.LogLevel[____exports.LogLevel.OFF] = "OFF"
--- Represents a logger that can be used to log messages with different severity levels.
-- 
-- Change the static level property to change the severity level of messages that are logged.
-- 
-- Change the static transports property to change the way messages are logged.
-- 
-- Use Logger.ignore to ignore a severity level.
-- 
-- @example const logger = new Logger("MyLogger");
-- Logger.level = LogLevel.DEBUG;
-- Logger.transports = { debug: print, info: print, warn: print, error: print };
____exports.Logger = __TS__Class()
local Logger = ____exports.Logger
Logger.name = "Logger"
function Logger.prototype.____constructor(self, name)
    self.name = name
end
function Logger.prototype.trace(self, message)
    if ____exports.Logger.level <= ____exports.LogLevel.TRACE then
        ____exports.Logger.transports:trace((("[TRACE] [" .. self.name) .. "] - ") .. message)
    end
end
function Logger.prototype.debug(self, message)
    if ____exports.Logger.level <= ____exports.LogLevel.DEBUG then
        ____exports.Logger.transports:debug((("[DEBUG] [" .. self.name) .. "] - ") .. message)
    end
end
function Logger.prototype.info(self, message)
    if ____exports.Logger.level <= ____exports.LogLevel.INFO then
        ____exports.Logger.transports:info((("[INFO] [" .. self.name) .. "] - ") .. message)
    end
end
function Logger.prototype.warn(self, message)
    if ____exports.Logger.level <= ____exports.LogLevel.WARN then
        ____exports.Logger.transports:warn((("[WARN] [" .. self.name) .. "] - ") .. message)
    end
end
function Logger.prototype.error(self, message)
    if ____exports.Logger.level <= ____exports.LogLevel.ERROR then
        ____exports.Logger.transports:error((("[ERROR] [" .. self.name) .. "] - ") .. message)
    end
end
function Logger.ignore(self)
end
Logger.level = ____exports.LogLevel.INFO
Logger.transports = {
    trace = ____exports.Logger.ignore,
    debug = ____exports.Logger.ignore,
    info = ____exports.Logger.ignore,
    warn = ____exports.Logger.ignore,
    error = ____exports.Logger.ignore
}
return ____exports
 end,
["src.dtos.error.dto"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.dtos.fire-at-position.dto"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.types.ground-group-task"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.types.helicopter-group-task"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.dtos.group-task.dto"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.types.coalition-side"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.dtos.coalition-side.dto"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.types.group-category"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.dtos.group-category.dto"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.dtos.position.dto"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.dtos.unit-health.dto"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.dtos.unit.dto"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.dtos.group.dto"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.dtos.operation-result.dto"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.types.airplane-group-task"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.dtos.set-task.dto"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.types.airbase-category"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.types.unit-category"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.wrappers.lookups"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
____exports.AIRBASE_CATEGORY_NAMES = {[Airbase.Category.SHIP] = "SHIP", [Airbase.Category.HELIPAD] = "HELIPAD", [Airbase.Category.AIRDROME] = "AIRDROME"}
____exports.GROUP_CATEGORY_NAMES = {
    [Group.Category.SHIP] = "SHIP",
    [Group.Category.HELICOPTER] = "HELICOPTER",
    [Group.Category.TRAIN] = "TRAIN",
    [Group.Category.GROUND] = "GROUND",
    [Group.Category.AIRPLANE] = "AIRPLANE"
}
____exports.UNIT_CATEGORY_NAMES = {
    [Unit.Category.SHIP] = "SHIP",
    [Unit.Category.HELICOPTER] = "HELICOPTER",
    [Unit.Category.GROUND_UNIT] = "GROUND_UNIT",
    [Unit.Category.STRUCTURE] = "STRUCTURE",
    [Unit.Category.AIRPLANE] = "AIRPLANE"
}
____exports.COALITION_NAMES = {[coalition.side.NEUTRAL] = "NEUTRAL", [coalition.side.RED] = "RED", [coalition.side.BLUE] = "BLUE"}
return ____exports
 end,
["src.types.unit-health"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.wrappers.wr-unit"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local __TS__Number = ____lualib.__TS__Number
local __TS__SetDescriptor = ____lualib.__TS__SetDescriptor
local __TS__ArrayMap = ____lualib.__TS__ArrayMap
local __TS__ArrayFind = ____lualib.__TS__ArrayFind
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
local ____geo_2Eservice = require("src.services.geo.service")
local geoService = ____geo_2Eservice.geoService
local ____lookups = require("src.wrappers.lookups")
local COALITION_NAMES = ____lookups.COALITION_NAMES
local GROUP_CATEGORY_NAMES = ____lookups.GROUP_CATEGORY_NAMES
____exports.WrUnit = __TS__Class()
local WrUnit = ____exports.WrUnit
WrUnit.name = "WrUnit"
function WrUnit.prototype.____constructor(self, unit)
    self.unit = unit
end
function WrUnit.prototype.toDto(self)
    return {
        id = self.id,
        name = self.name,
        coalition = self.coalitionName,
        category = self.categoryName,
        type = self.typeName,
        typeDisplayName = self.typeDisplayName,
        position = geoService:vec3ToPosition(self.point),
        health = self.health,
        speedMax = self.speedMax,
        speed = self.speed,
        ammo = self.ammo,
        fuel = self.fuel,
        active = self.active,
        threatRange = self.threatRange
    }
end
__TS__SetDescriptor(
    WrUnit.prototype,
    "id",
    {get = function(self)
        return __TS__Number(self.unit:getID())
    end},
    true
)
__TS__SetDescriptor(
    WrUnit.prototype,
    "name",
    {get = function(self)
        return self.unit:getName()
    end},
    true
)
__TS__SetDescriptor(
    WrUnit.prototype,
    "coalition",
    {get = function(self)
        return self.unit:getCoalition()
    end},
    true
)
__TS__SetDescriptor(
    WrUnit.prototype,
    "coalitionName",
    {get = function(self)
        return COALITION_NAMES[self.coalition]
    end},
    true
)
__TS__SetDescriptor(
    WrUnit.prototype,
    "category",
    {get = function(self)
        return self.unit:getCategory()
    end},
    true
)
__TS__SetDescriptor(
    WrUnit.prototype,
    "categoryName",
    {get = function(self)
        return GROUP_CATEGORY_NAMES[self.category]
    end},
    true
)
__TS__SetDescriptor(
    WrUnit.prototype,
    "typeName",
    {get = function(self)
        return self.unit:getTypeName()
    end},
    true
)
__TS__SetDescriptor(
    WrUnit.prototype,
    "typeDisplayName",
    {get = function(self)
        return self.unit:getDesc().displayName
    end},
    true
)
__TS__SetDescriptor(
    WrUnit.prototype,
    "point",
    {get = function(self)
        return self.unit:getPoint()
    end},
    true
)
__TS__SetDescriptor(
    WrUnit.prototype,
    "health",
    {get = function(self)
        return {
            current = self.unit:getLife(),
            max = self.unit:getLife0()
        }
    end},
    true
)
__TS__SetDescriptor(
    WrUnit.prototype,
    "speedMax",
    {get = function(self)
        return self.unit:getDesc().speedMax
    end},
    true
)
__TS__SetDescriptor(
    WrUnit.prototype,
    "speed",
    {get = function(self)
        local velocity = self.unit:getVelocity()
        return math.sqrt(velocity.x ^ 2 + velocity.y ^ 2 + velocity.z ^ 2)
    end},
    true
)
__TS__SetDescriptor(
    WrUnit.prototype,
    "velocity",
    {get = function(self)
        return self.unit:getVelocity()
    end},
    true
)
__TS__SetDescriptor(
    WrUnit.prototype,
    "ammo",
    {get = function(self)
        local ammo = self.unit:getAmmo()
        local ____opt_0 = ammo
        return ____opt_0 and __TS__ArrayMap(
            ammo,
            function(____, it) return {type = it.desc.typeName, typeDisplayName = it.desc.displayName, count = it.count} end
        ) or ({})
    end},
    true
)
__TS__SetDescriptor(
    WrUnit.prototype,
    "fuel",
    {get = function(self)
        return self.unit:getFuel()
    end},
    true
)
__TS__SetDescriptor(
    WrUnit.prototype,
    "active",
    {get = function(self)
        return self.unit:isActive()
    end},
    true
)
__TS__SetDescriptor(
    WrUnit.prototype,
    "threatRange",
    {get = function(self)
        local ____opt_2 = __TS__ArrayFind(
            __war_room_cars,
            function(____, it) return it.Name == self.typeName end
        )
        return ____opt_2 and ____opt_2.ThreatRange or 0
    end},
    true
)
return ____exports
 end,
["src.wrappers.wr-group"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local __TS__ArraySome = ____lualib.__TS__ArraySome
local __TS__ArrayMap = ____lualib.__TS__ArrayMap
local __TS__Number = ____lualib.__TS__Number
local __TS__SetDescriptor = ____lualib.__TS__SetDescriptor
local __TS__New = ____lualib.__TS__New
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
local ____geo_2Eservice = require("src.services.geo.service")
local geoService = ____geo_2Eservice.geoService
local ____lookups = require("src.wrappers.lookups")
local COALITION_NAMES = ____lookups.COALITION_NAMES
local GROUP_CATEGORY_NAMES = ____lookups.GROUP_CATEGORY_NAMES
local ____wr_2Dunit = require("src.wrappers.wr-unit")
local WrUnit = ____wr_2Dunit.WrUnit
____exports.WrGroup = __TS__Class()
local WrGroup = ____exports.WrGroup
WrGroup.name = "WrGroup"
function WrGroup.prototype.____constructor(self, group)
    self.group = group
end
function WrGroup.prototype.setSpeed(self, speed)
    self.group:getController():setSpeed(speed)
end
function WrGroup.prototype.toDto(self)
    return {
        id = self.id,
        name = self.name,
        coalition = self.coalitionName,
        category = self.categoryName,
        size = self.size,
        active = __TS__ArraySome(
            self.units,
            function(____, u) return u.active end
        ),
        units = __TS__ArrayMap(
            self.units,
            function(____, unit) return {
                id = unit.id,
                name = unit.name,
                coalition = unit.coalitionName,
                category = unit.categoryName,
                type = unit.typeName,
                typeDisplayName = unit.typeDisplayName,
                position = geoService:vec3ToPosition(unit.point),
                health = unit.health,
                speedMax = unit.speedMax,
                speed = unit.speed,
                ammo = unit.ammo,
                fuel = unit.fuel,
                active = unit.active,
                threatRange = unit.threatRange
            } end
        )
    }
end
__TS__SetDescriptor(
    WrGroup.prototype,
    "id",
    {get = function(self)
        return __TS__Number(self.group:getID())
    end},
    true
)
__TS__SetDescriptor(
    WrGroup.prototype,
    "name",
    {get = function(self)
        return self.group:getName()
    end},
    true
)
__TS__SetDescriptor(
    WrGroup.prototype,
    "coalition",
    {get = function(self)
        return self.group:getCoalition()
    end},
    true
)
__TS__SetDescriptor(
    WrGroup.prototype,
    "coalitionName",
    {get = function(self)
        return COALITION_NAMES[self.coalition]
    end},
    true
)
__TS__SetDescriptor(
    WrGroup.prototype,
    "category",
    {get = function(self)
        return self.group:getCategory()
    end},
    true
)
__TS__SetDescriptor(
    WrGroup.prototype,
    "categoryName",
    {get = function(self)
        return GROUP_CATEGORY_NAMES[self.category]
    end},
    true
)
__TS__SetDescriptor(
    WrGroup.prototype,
    "size",
    {get = function(self)
        return self.group:getSize()
    end},
    true
)
__TS__SetDescriptor(
    WrGroup.prototype,
    "units",
    {get = function(self)
        return __TS__ArrayMap(
            self.group:getUnits(),
            function(____, it) return __TS__New(WrUnit, it) end
        )
    end},
    true
)
return ____exports
 end,
["src.wrappers.wr-airplane-group"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local __TS__ClassExtends = ____lualib.__TS__ClassExtends
local __TS__ObjectAssign = ____lualib.__TS__ObjectAssign
local __TS__ArrayMap = ____lualib.__TS__ArrayMap
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
local ____geo_2Eservice = require("src.services.geo.service")
local geoService = ____geo_2Eservice.geoService
local ____wr_2Dgroup = require("src.wrappers.wr-group")
local WrGroup = ____wr_2Dgroup.WrGroup
____exports.WrAirplaneGroup = __TS__Class()
local WrAirplaneGroup = ____exports.WrAirplaneGroup
WrAirplaneGroup.name = "WrAirplaneGroup"
__TS__ClassExtends(WrAirplaneGroup, WrGroup)
function WrAirplaneGroup.prototype.____constructor(self, group)
    WrGroup.prototype.____constructor(self, group)
end
function WrAirplaneGroup.prototype.setTask(self, task)
    local controller = self.group:getController()
    controller:setTask({
        id = "Mission",
        params = {route = {points = __TS__ArrayMap(
            task.route.coordinates,
            function(____, it, idx) return __TS__ObjectAssign(
                {
                    alt = it[3],
                    type = AI.Task.WaypointType.TURNING_POINT,
                    ETA = idx,
                    alt_type = AI.Task.AltitudeType.RADIO,
                    formation_template = "",
                    speed_locked = true,
                    ETA_locked = false,
                    speed = task.speed,
                    action = AI.Task.WaypointType.TURNING_POINT,
                    task = {id = "ComboTask", params = {tasks = {}}}
                },
                geoService:positionToVec2(it)
            ) end
        )}}
    })
end
return ____exports
 end,
["src.types.equipment"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.wrappers.wr-airbase"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local __TS__Number = ____lualib.__TS__Number
local __TS__SetDescriptor = ____lualib.__TS__SetDescriptor
local __TS__ObjectKeys = ____lualib.__TS__ObjectKeys
local __TS__ArrayForEach = ____lualib.__TS__ArrayForEach
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
local ____lookups = require("src.wrappers.lookups")
local AIRBASE_CATEGORY_NAMES = ____lookups.AIRBASE_CATEGORY_NAMES
local COALITION_NAMES = ____lookups.COALITION_NAMES
____exports.WrAirbase = __TS__Class()
local WrAirbase = ____exports.WrAirbase
WrAirbase.name = "WrAirbase"
function WrAirbase.prototype.____constructor(self, airbase)
    self.airbase = airbase
end
__TS__SetDescriptor(
    WrAirbase.prototype,
    "id",
    {get = function(self)
        return __TS__Number(self.airbase:getID())
    end},
    true
)
__TS__SetDescriptor(
    WrAirbase.prototype,
    "name",
    {get = function(self)
        return self.airbase:getName()
    end},
    true
)
__TS__SetDescriptor(
    WrAirbase.prototype,
    "coalition",
    {get = function(self)
        return self.airbase:getCoalition()
    end},
    true
)
__TS__SetDescriptor(
    WrAirbase.prototype,
    "coalitionName",
    {get = function(self)
        return COALITION_NAMES[self.coalition]
    end},
    true
)
__TS__SetDescriptor(
    WrAirbase.prototype,
    "category",
    {get = function(self)
        return self.airbase:getCategory()
    end},
    true
)
__TS__SetDescriptor(
    WrAirbase.prototype,
    "categoryName",
    {get = function(self)
        return AIRBASE_CATEGORY_NAMES[self.category]
    end},
    true
)
__TS__SetDescriptor(
    WrAirbase.prototype,
    "point",
    {get = function(self)
        return self.airbase:getPoint()
    end},
    true
)
__TS__SetDescriptor(
    WrAirbase.prototype,
    "equipment",
    {get = function(self)
        local eq = {aircraft = {}}
        local inventory = self.airbase:getWarehouse():getInventory()
        __TS__ArrayForEach(
            __TS__ObjectKeys(inventory.aircraft),
            function(____, key)
                local quantity = inventory.aircraft[key]
                local name = net.dostring_in("server", ("return db.localization.types['" .. key) .. "']")
                local ____eq_aircraft_0 = eq.aircraft
                ____eq_aircraft_0[#____eq_aircraft_0 + 1] = {quantity = quantity, name = name, type = key}
            end
        )
        return eq
    end},
    true
)
return ____exports
 end,
["src.wrappers.wr-ground-group"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local __TS__ClassExtends = ____lualib.__TS__ClassExtends
local __TS__ObjectAssign = ____lualib.__TS__ObjectAssign
local __TS__ArrayMap = ____lualib.__TS__ArrayMap
local __TS__New = ____lualib.__TS__New
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
local ____tslua_2Dcommon = require("lua_modules.@flying-dice.tslua-common.dist.index")
local Logger = ____tslua_2Dcommon.Logger
local ____geo_2Eservice = require("src.services.geo.service")
local geoService = ____geo_2Eservice.geoService
local ____wr_2Dgroup = require("src.wrappers.wr-group")
local WrGroup = ____wr_2Dgroup.WrGroup
____exports.WrGroundGroup = __TS__Class()
local WrGroundGroup = ____exports.WrGroundGroup
WrGroundGroup.name = "WrGroundGroup"
__TS__ClassExtends(WrGroundGroup, WrGroup)
function WrGroundGroup.prototype.____constructor(self, group)
    WrGroup.prototype.____constructor(self, group)
end
function WrGroundGroup.prototype.fireAtPosition(self, point)
    local controller = self.group:getController()
    controller:pushTask({
        id = "FireAtPoint",
        params = {point = geoService:positionToVec2(point)}
    })
end
function WrGroundGroup.prototype.setTask(self, task)
    local controller = self.group:getController()
    controller:setTask({
        id = "Mission",
        params = {route = {points = __TS__ArrayMap(
            task.route.coordinates,
            function(____, it, idx) return __TS__ObjectAssign(
                {
                    alt = geoService:getHeight(it),
                    type = AI.Task.WaypointType.TURNING_POINT,
                    ETA = idx,
                    alt_type = AI.Task.AltitudeType.RADIO,
                    formation_template = "",
                    speed_locked = true,
                    ETA_locked = false,
                    speed = task.speed,
                    action = (not task.useRoads or idx == #task.route.coordinates - 1) and AI.Task.VehicleFormation.OFF_ROAD or AI.Task.VehicleFormation.ON_ROAD,
                    task = {id = "ComboTask", params = {tasks = {}}}
                },
                geoService:positionToVec2(it)
            ) end
        )}}
    })
end
WrGroundGroup.LOGGER = __TS__New(Logger, "wr-ground-group")
return ____exports
 end,
["src.wrappers.wr-helicopter-group"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local __TS__ClassExtends = ____lualib.__TS__ClassExtends
local __TS__ObjectAssign = ____lualib.__TS__ObjectAssign
local __TS__ArrayMap = ____lualib.__TS__ArrayMap
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
local ____geo_2Eservice = require("src.services.geo.service")
local geoService = ____geo_2Eservice.geoService
local ____wr_2Dgroup = require("src.wrappers.wr-group")
local WrGroup = ____wr_2Dgroup.WrGroup
____exports.WrHelicopterGroup = __TS__Class()
local WrHelicopterGroup = ____exports.WrHelicopterGroup
WrHelicopterGroup.name = "WrHelicopterGroup"
__TS__ClassExtends(WrHelicopterGroup, WrGroup)
function WrHelicopterGroup.prototype.____constructor(self, group)
    WrGroup.prototype.____constructor(self, group)
end
function WrHelicopterGroup.prototype.setTask(self, task)
    local controller = self.group:getController()
    controller:setTask({
        id = "Mission",
        params = {route = {points = __TS__ArrayMap(
            task.route.coordinates,
            function(____, it, idx) return __TS__ObjectAssign(
                {
                    alt = it[3],
                    type = AI.Task.WaypointType.TURNING_POINT,
                    ETA = idx,
                    alt_type = AI.Task.AltitudeType.RADIO,
                    formation_template = "",
                    speed_locked = true,
                    ETA_locked = false,
                    speed = task.speed,
                    action = AI.Task.WaypointType.TURNING_POINT,
                    task = {id = "ComboTask", params = {tasks = {}}}
                },
                geoService:positionToVec2(it)
            ) end
        )}}
    })
end
return ____exports
 end,
["src.wrappers.wr-coalition"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local __TS__New = ____lualib.__TS__New
local __TS__ArrayMap = ____lualib.__TS__ArrayMap
local __TS__SetDescriptor = ____lualib.__TS__SetDescriptor
local __TS__ArrayForEach = ____lualib.__TS__ArrayForEach
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
local ____wr_2Dairbase = require("src.wrappers.wr-airbase")
local WrAirbase = ____wr_2Dairbase.WrAirbase
local ____wr_2Dairplane_2Dgroup = require("src.wrappers.wr-airplane-group")
local WrAirplaneGroup = ____wr_2Dairplane_2Dgroup.WrAirplaneGroup
local ____wr_2Dground_2Dgroup = require("src.wrappers.wr-ground-group")
local WrGroundGroup = ____wr_2Dground_2Dgroup.WrGroundGroup
local ____wr_2Dhelicopter_2Dgroup = require("src.wrappers.wr-helicopter-group")
local WrHelicopterGroup = ____wr_2Dhelicopter_2Dgroup.WrHelicopterGroup
____exports.WrCoalition = __TS__Class()
local WrCoalition = ____exports.WrCoalition
WrCoalition.name = "WrCoalition"
function WrCoalition.prototype.____constructor(self, side)
    self.side = side
end
__TS__SetDescriptor(
    WrCoalition.prototype,
    "airbases",
    {get = function(self)
        return __TS__ArrayMap(
            coalition.getAirbases(self.side),
            function(____, airbase) return __TS__New(WrAirbase, airbase) end
        )
    end},
    true
)
__TS__SetDescriptor(
    WrCoalition.prototype,
    "groups",
    {get = function(self)
        local groups = {}
        __TS__ArrayForEach(
            coalition.getGroups(self.side),
            function(____, group)
                if group:getCategory() == Group.Category.GROUND then
                    groups[#groups + 1] = __TS__New(WrGroundGroup, group)
                end
                if group:getCategory() == Group.Category.HELICOPTER then
                    groups[#groups + 1] = __TS__New(WrHelicopterGroup, group)
                end
                if group:getCategory() == Group.Category.AIRPLANE then
                    groups[#groups + 1] = __TS__New(WrAirplaneGroup, group)
                end
            end
        )
        return groups
    end},
    true
)
____exports.blueCoalition = __TS__New(____exports.WrCoalition, coalition.side.BLUE)
____exports.redCoalition = __TS__New(____exports.WrCoalition, coalition.side.RED)
____exports.neutralCoalition = __TS__New(____exports.WrCoalition, coalition.side.NEUTRAL)
return ____exports
 end,
["src.services.group.service"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local __TS__New = ____lualib.__TS__New
local __TS__SparseArrayNew = ____lualib.__TS__SparseArrayNew
local __TS__SparseArrayPush = ____lualib.__TS__SparseArrayPush
local __TS__SparseArraySpread = ____lualib.__TS__SparseArraySpread
local __TS__ArrayMap = ____lualib.__TS__ArrayMap
local __TS__InstanceOf = ____lualib.__TS__InstanceOf
local __TS__ArrayFind = ____lualib.__TS__ArrayFind
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
local ____tslua_2Dcommon = require("lua_modules.@flying-dice.tslua-common.dist.index")
local Logger = ____tslua_2Dcommon.Logger
local ____wr_2Dairplane_2Dgroup = require("src.wrappers.wr-airplane-group")
local WrAirplaneGroup = ____wr_2Dairplane_2Dgroup.WrAirplaneGroup
local ____wr_2Dcoalition = require("src.wrappers.wr-coalition")
local blueCoalition = ____wr_2Dcoalition.blueCoalition
local neutralCoalition = ____wr_2Dcoalition.neutralCoalition
local redCoalition = ____wr_2Dcoalition.redCoalition
local ____wr_2Dground_2Dgroup = require("src.wrappers.wr-ground-group")
local WrGroundGroup = ____wr_2Dground_2Dgroup.WrGroundGroup
local ____wr_2Dhelicopter_2Dgroup = require("src.wrappers.wr-helicopter-group")
local WrHelicopterGroup = ____wr_2Dhelicopter_2Dgroup.WrHelicopterGroup
local ____geo_2Eservice = require("src.services.geo.service")
local geoService = ____geo_2Eservice.geoService
____exports.GroupService = __TS__Class()
local GroupService = ____exports.GroupService
GroupService.name = "GroupService"
function GroupService.prototype.____constructor(self, logger)
    if logger == nil then
        logger = __TS__New(Logger, "group-service")
    end
    self.logger = logger
end
function GroupService.prototype.getGroup(self, groupId)
    local ____opt_0 = self:getById(groupId)
    return ____opt_0 and ____opt_0:toDto()
end
function GroupService.prototype.getGroups(self)
    local ____array_2 = __TS__SparseArrayNew(unpack(blueCoalition.groups))
    __TS__SparseArrayPush(
        ____array_2,
        unpack(redCoalition.groups)
    )
    __TS__SparseArrayPush(
        ____array_2,
        unpack(neutralCoalition.groups)
    )
    return __TS__ArrayMap(
        {__TS__SparseArraySpread(____array_2)},
        function(____, group) return group:toDto() end
    )
end
function GroupService.prototype.getTask(self, groupId)
    return ____exports.GroupService.tasks[groupId]
end
function GroupService.prototype.setTask(self, groupId, task)
    self.logger:info("Setting Group Task " .. tostring(groupId))
    local group = self:getById(groupId)
    if not group then
        self.logger:error(("Group " .. tostring(group)) .. " not found")
        return nil
    end
    if __TS__InstanceOf(group, WrGroundGroup) then
        local groundTask = task
        if groundTask.useRoads then
            groundTask.route.coordinates = geoService:getRouteOnRoads(groundTask.route.coordinates)
        end
        group:setTask(task)
    end
    if __TS__InstanceOf(group, WrHelicopterGroup) then
        group:setTask(task)
    end
    if __TS__InstanceOf(group, WrAirplaneGroup) then
        group:setTask(task)
    end
    ____exports.GroupService.tasks[group.id] = task
    return task
end
function GroupService.prototype.getById(self, groupId)
    self.logger:debug("Searching for group with ID: " .. tostring(groupId))
    local ____array_3 = __TS__SparseArrayNew(unpack(blueCoalition.groups))
    __TS__SparseArrayPush(
        ____array_3,
        unpack(redCoalition.groups)
    )
    __TS__SparseArrayPush(
        ____array_3,
        unpack(neutralCoalition.groups)
    )
    return __TS__ArrayFind(
        {__TS__SparseArraySpread(____array_3)},
        function(____, g) return g.id == groupId end
    )
end
GroupService.tasks = {}
____exports.groupService = __TS__New(____exports.GroupService)
return ____exports
 end,
["src.routes.group"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__New = ____lualib.__TS__New
local __TS__Number = ____lualib.__TS__Number
local __TS__InstanceOf = ____lualib.__TS__InstanceOf
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
local ____tslua_2Dcommon = require("lua_modules.@flying-dice.tslua-common.dist.index")
local Logger = ____tslua_2Dcommon.Logger
local ____tslua_2Dhttp = require("lua_modules.@flying-dice.tslua-http.dist.index")
local HttpStatus = ____tslua_2Dhttp.HttpStatus
local json = require("lua_modules.@flying-dice.tslua-rxi-json.index")
local ____app = require("src.app")
local GET = ____app.GET
local POST = ____app.POST
local ____openapi = require("src.openapi.index")
local body = ____openapi.body
local responses = ____openapi.responses
local ____group_2Eservice = require("src.services.group.service")
local groupService = ____group_2Eservice.groupService
local ____wr_2Dground_2Dgroup = require("src.wrappers.wr-ground-group")
local WrGroundGroup = ____wr_2Dground_2Dgroup.WrGroundGroup
local logger = __TS__New(Logger, "group-router")
GET(
    nil,
    "/groups/:id",
    {
        operationId = "getGroup",
        parameters = {{name = "id", ["in"] = "path", required = true, schema = {type = "number"}}},
        responses = responses(nil, {[HttpStatus.OK] = {{description = "Result"}, "GroupDto"}, [HttpStatus.NOT_FOUND] = {{description = "No Group Found"}, "ErrorDto"}})
    },
    function(____, req, res)
        local id = __TS__Number(req.parameters.id)
        logger:info("Getting Group " .. tostring(id))
        local group = groupService:getGroup(id)
        if group then
            res:json(group)
        else
            res:status(HttpStatus.NOT_FOUND):json({error = "No Group Found"})
        end
    end
)
GET(
    nil,
    "/groups/:id/task",
    {
        operationId = "getGroupTask",
        parameters = {{name = "id", ["in"] = "path", required = true, schema = {type = "number"}}},
        responses = responses(nil, {[HttpStatus.OK] = {{description = "Result"}, "GroupTaskDto"}, [HttpStatus.NOT_FOUND] = {{description = "No task or Group Found"}, "ErrorDto"}})
    },
    function(____, req, res)
        local id = __TS__Number(req.parameters.id)
        logger:info("Getting Group Task " .. tostring(id))
        local task = groupService:getTask(id)
        if task then
            res:json(task)
        else
            res:status(HttpStatus.NOT_FOUND):json({error = "No task or Group Found"})
        end
    end
)
POST(
    nil,
    "/groups/:id/task",
    {
        operationId = "setGroupTask",
        parameters = {{name = "id", ["in"] = "path", required = true, schema = {type = "number"}}},
        requestBody = body(nil, "SetTaskDto"),
        responses = responses(nil, {[HttpStatus.OK] = {{description = "Result"}, "OperationResultDto"}})
    },
    function(____, req, res)
        local id = __TS__Number(req.parameters.id)
        logger:info("Setting Group Waypoint " .. tostring(id))
        local task = json.decode(req.body)
        local result = groupService:setTask(id, task)
        if result then
            res:json(result)
        else
            res:json({error = "No Group Found"})
        end
    end
)
POST(
    nil,
    "/groups/:id/fire-at-position",
    {
        operationId = "fireAtPosition",
        parameters = {{name = "id", ["in"] = "path", required = true, schema = {type = "number"}}},
        requestBody = body(nil, "FireAtPositionDto"),
        responses = responses(nil, {[HttpStatus.OK] = {{description = "Result"}, "OperationResultDto"}})
    },
    function(____, req, res)
        local id = __TS__Number(req.parameters.id)
        logger:info(("Ordering Group " .. tostring(id)) .. " to fire at position")
        local ____json_decode_result_0 = json.decode(req.body)
        local position = ____json_decode_result_0.position
        local group = groupService:getById(id)
        if not group then
            res:status(HttpStatus.NOT_FOUND)
            res:json({error = "No Group Found"})
        elseif __TS__InstanceOf(group, WrGroundGroup) then
            group:fireAtPosition(position)
            res:json({result = true})
        else
            res:status(HttpStatus.BAD_REQUEST)
            res:json({error = "Group is not a ground group"})
        end
    end
)
return ____exports
 end,
["src.dtos.health.dto"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.routes.health"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
local ____tslua_2Dhttp = require("lua_modules.@flying-dice.tslua-http.dist.index")
local HttpStatus = ____tslua_2Dhttp.HttpStatus
local ____app = require("src.app")
local GET = ____app.GET
local ____openapi = require("src.openapi.index")
local responses = ____openapi.responses
GET(
    nil,
    "/health",
    {
        operationId = "getHealth",
        responses = responses(nil, {[HttpStatus.OK] = {{description = "OK"}, "HealthDto"}})
    },
    function(____, req, res)
        res:json({status = "OK", _APP_VERSION = _APP_VERSION, _VERSION = _VERSION, _ARCHITECTURE = _ARCHITECTURE})
    end
)
return ____exports
 end,
["src.dtos.airbase-category.dto"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.dtos.equipment.dto"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.dtos.airbase.dto"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.dtos.time.dto"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
____exports.StartDateMonth = StartDateMonth or ({})
____exports.StartDateMonth.January = 1
____exports.StartDateMonth[____exports.StartDateMonth.January] = "January"
____exports.StartDateMonth.February = 2
____exports.StartDateMonth[____exports.StartDateMonth.February] = "February"
____exports.StartDateMonth.March = 3
____exports.StartDateMonth[____exports.StartDateMonth.March] = "March"
____exports.StartDateMonth.April = 4
____exports.StartDateMonth[____exports.StartDateMonth.April] = "April"
____exports.StartDateMonth.May = 5
____exports.StartDateMonth[____exports.StartDateMonth.May] = "May"
____exports.StartDateMonth.June = 6
____exports.StartDateMonth[____exports.StartDateMonth.June] = "June"
____exports.StartDateMonth.July = 7
____exports.StartDateMonth[____exports.StartDateMonth.July] = "July"
____exports.StartDateMonth.August = 8
____exports.StartDateMonth[____exports.StartDateMonth.August] = "August"
____exports.StartDateMonth.September = 9
____exports.StartDateMonth[____exports.StartDateMonth.September] = "September"
____exports.StartDateMonth.October = 10
____exports.StartDateMonth[____exports.StartDateMonth.October] = "October"
____exports.StartDateMonth.November = 11
____exports.StartDateMonth[____exports.StartDateMonth.November] = "November"
____exports.StartDateMonth.December = 12
____exports.StartDateMonth[____exports.StartDateMonth.December] = "December"
return ____exports
 end,
["src.dtos.state.dto"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.services.airbase.service"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local __TS__SparseArrayNew = ____lualib.__TS__SparseArrayNew
local __TS__SparseArrayPush = ____lualib.__TS__SparseArrayPush
local __TS__SparseArraySpread = ____lualib.__TS__SparseArraySpread
local __TS__ArrayMap = ____lualib.__TS__ArrayMap
local __TS__New = ____lualib.__TS__New
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
local ____wr_2Dcoalition = require("src.wrappers.wr-coalition")
local blueCoalition = ____wr_2Dcoalition.blueCoalition
local neutralCoalition = ____wr_2Dcoalition.neutralCoalition
local redCoalition = ____wr_2Dcoalition.redCoalition
local ____geo_2Eservice = require("src.services.geo.service")
local geoService = ____geo_2Eservice.geoService
____exports.AirbaseService = __TS__Class()
local AirbaseService = ____exports.AirbaseService
AirbaseService.name = "AirbaseService"
function AirbaseService.prototype.____constructor(self)
end
function AirbaseService.prototype.getAirbases(self)
    local ____array_0 = __TS__SparseArrayNew(unpack(redCoalition.airbases))
    __TS__SparseArrayPush(
        ____array_0,
        unpack(blueCoalition.airbases)
    )
    __TS__SparseArrayPush(
        ____array_0,
        unpack(neutralCoalition.airbases)
    )
    return __TS__ArrayMap(
        {__TS__SparseArraySpread(____array_0)},
        function(____, it) return {
            id = it.id,
            name = it.name,
            coalition = it.coalitionName,
            category = it.categoryName,
            position = geoService:vec3ToPosition(it.point),
            equipment = it.equipment
        } end
    )
end
____exports.airbaseService = __TS__New(____exports.AirbaseService)
return ____exports
 end,
["src.functions.date"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__NumberToFixed = ____lualib.__TS__NumberToFixed
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
function ____exports.isLeapYear(self, year)
    return year % 4 == 0 and year % 100 ~= 0 or year % 400 == 0
end
function ____exports.isEndOfMonth(self, day, month, year)
    local monthLengths = {
        31,
        ____exports.isLeapYear(nil, year) and 29 or 28,
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31
    }
    return day >= monthLengths[month]
end
function ____exports.twoDigits(self, n)
    return n < 10 and "0" .. __TS__NumberToFixed(n, 0) or __TS__NumberToFixed(n, 0)
end
function ____exports.getDateTimeString(self, ____bindingPattern0)
    local startTime
    local time
    local startDate
    startDate = ____bindingPattern0.startDate
    time = ____bindingPattern0.time
    startTime = ____bindingPattern0.startTime
    local totalSeconds = startTime + time
    local currentDay = startDate.day
    local currentMonth = startDate.month
    local currentYear = startDate.year
    local daysPassed = math.floor(totalSeconds / (3600 * 24))
    totalSeconds = totalSeconds - daysPassed * 3600 * 24
    do
        local i = 0
        while i < daysPassed do
            if ____exports.isEndOfMonth(nil, currentDay, currentMonth, currentYear) then
                currentDay = 1
                if currentMonth == 12 then
                    currentMonth = 1
                    currentYear = currentYear + 1
                else
                    currentMonth = currentMonth + 1
                end
            else
                currentDay = currentDay + 1
            end
            i = i + 1
        end
    end
    local hours = math.floor(totalSeconds / 3600)
    totalSeconds = totalSeconds % 3600
    local minutes = math.floor(totalSeconds / 60)
    local seconds = totalSeconds % 60
    return (((((((((tostring(currentYear) .. "-") .. ____exports.twoDigits(nil, currentMonth)) .. "-") .. ____exports.twoDigits(nil, currentDay)) .. "T") .. ____exports.twoDigits(nil, hours)) .. ":") .. ____exports.twoDigits(nil, minutes)) .. ":") .. ____exports.twoDigits(nil, seconds)
end
return ____exports
 end,
["src.services.time.service"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local __TS__New = ____lualib.__TS__New
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
local ____date = require("src.functions.date")
local getDateTimeString = ____date.getDateTimeString
____exports.TimeService = __TS__Class()
local TimeService = ____exports.TimeService
TimeService.name = "TimeService"
function TimeService.prototype.____constructor(self)
end
function TimeService.prototype.getMissionTime(self)
    return {
        startDate = {day = env.mission.date.Day, year = env.mission.date.Year, month = env.mission.date.Month},
        startTime = env.mission.start_time,
        time = timer.getTime()
    }
end
function TimeService.prototype.getCurrentDateTimeString(self)
    return getDateTimeString(
        nil,
        self:getMissionTime()
    )
end
____exports.timeService = __TS__New(____exports.TimeService)
return ____exports
 end,
["src.routes.state"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
local ____tslua_2Dhttp = require("lua_modules.@flying-dice.tslua-http.dist.index")
local HttpStatus = ____tslua_2Dhttp.HttpStatus
local ____app = require("src.app")
local GET = ____app.GET
local ____openapi = require("src.openapi.index")
local responses = ____openapi.responses
local ____airbase_2Eservice = require("src.services.airbase.service")
local airbaseService = ____airbase_2Eservice.airbaseService
local ____group_2Eservice = require("src.services.group.service")
local groupService = ____group_2Eservice.groupService
local ____time_2Eservice = require("src.services.time.service")
local timeService = ____time_2Eservice.timeService
GET(
    nil,
    "/state",
    {
        operationId = "getState",
        responses = responses(nil, {[HttpStatus.OK] = {{description = "Current Game State Export"}, "StateDto"}})
    },
    function(____, req, res)
        res:json({
            theatre = env.mission.theatre,
            time = timeService:getMissionTime(),
            timeString = timeService:getCurrentDateTimeString(),
            airbases = airbaseService:getAirbases(),
            groups = groupService:getGroups()
        })
    end
)
return ____exports
 end,
["src.routes.index"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
require("src.routes.api-docs")
require("src.routes.camera")
require("src.routes.group")
require("src.routes.health")
require("src.routes.state")
return ____exports
 end,
["src.index"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__New = ____lualib.__TS__New
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
local ____tslua_2Dcommon = require("lua_modules.@flying-dice.tslua-common.dist.index")
local LogLevel = ____tslua_2Dcommon.LogLevel
local Logger = ____tslua_2Dcommon.Logger
local ____app = require("src.app")
local app = ____app.app
require("src.routes.index")
local logger = __TS__New(Logger, "war-room")
Logger.level = LogLevel.TRACE
Logger.transports = {
    trace = function(____, message) return env.info(message) end,
    debug = function(____, message) return env.info(message) end,
    info = function(____, message) return env.info(message) end,
    warn = function(____, message) return env.warning(message, true) end,
    error = function(____, message) return env.error(message, true) end
}
net.dostring_in("server", "function __war_room_dumpt(t)\n    if type(t) == 'table' then\n        local s = '{ '\n        for k, v in pairs(t) do\n            if type(k) ~= 'number' then\n                k = '\"' .. k .. '\"'\n            end\n            s = s .. '[' .. k .. '] = ' .. __war_room_dumpt(v) .. ','\n        end\n        return s .. '} '\n    elseif type(t) == 'string' then\n        return '[[' .. tostring(t) .. ']]'\n\telse\n\t\treturn tostring(t)\n    end\nend")
do
    local function ____catch(e)
        logger:error("Error loading cars " .. tostring(e))
    end
    local ____try, ____hasReturned = pcall(function()
        logger:info("Fetching cars from server database")
        local res = net.dostring_in("server", "return __war_room_dumpt(db.Units.Cars.Car)")
        logger:info("Cars: " .. tostring(res))
        logger:info("Loading cars restore script")
        local loaded = loadstring("_G.__war_room_cars = " .. tostring(res))
        if loaded then
            logger:info("Executing Load")
            loaded()
        else
            logger:warn("Failed to load cars no function returned from loadstring")
        end
    end)
    if not ____try then
        ____catch(____hasReturned)
    end
end
if __war_room_app ~= nil then
    logger:info("Closing existing app")
    __war_room_app:close()
end
logger:info("Starting app")
__war_room_app = app
if __war_room_app_function_id ~= nil then
    logger:info("Removing existing function " .. tostring(__war_room_app_function_id))
    timer.removeFunction(__war_room_app_function_id)
end
__war_room_app_function_id = timer.scheduleFunction(
    function()
        do
            local function ____catch(e)
                env.error("Error accepting client: " .. tostring(e))
            end
            local ____try, ____hasReturned = pcall(function()
                app:acceptNextClient()
            end)
            if not ____try then
                ____catch(____hasReturned)
            end
        end
        return timer.getTime() + 0.1
    end,
    {},
    timer.getTime() + 0.1
)
logger:info("Started server loop with functionId " .. tostring(__war_room_app_function_id))
logger:info(((("War Room Listening on http://" .. (WAR_ROOM_ADDRESS or "127.0.0.1")) .. ":") .. tostring(WAR_ROOM_PORT or 1630)) .. "/")
return ____exports
 end,
["src.dtos.linestring.dto"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.dtos.unit-category.dto"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
return ____exports
 end,
["src.functions.decode-uri-component"] = function(...) 
local ____lualib = require("lualib_bundle")
local Error = ____lualib.Error
local RangeError = ____lualib.RangeError
local ReferenceError = ____lualib.ReferenceError
local SyntaxError = ____lualib.SyntaxError
local TypeError = ____lualib.TypeError
local URIError = ____lualib.URIError
local __TS__New = ____lualib.__TS__New
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
function ____exports.decodeUriComponent(self, encodedString)
    local decodedString = string.gsub(encodedString, "+", " ")
    local fullyDecodedString = string.gsub(
        decodedString,
        "%%(%x%x)",
        function(h)
            local charNum = tonumber(h, 16)
            if not charNum then
                error(
                    __TS__New(Error, "Invalid hex code for " .. h),
                    0
                )
            end
            return string.char(charNum)
        end
    )
    return fullyDecodedString
end
return ____exports
 end,
["src.openapi.openapi3-ts.model.server"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
____exports.Server = __TS__Class()
local Server = ____exports.Server
Server.name = "Server"
function Server.prototype.____constructor(self, url, desc)
    self.url = url
    self.description = desc
    self.variables = {}
end
function Server.prototype.addVariable(self, name, variable)
    self.variables[name] = variable
end
____exports.ServerVariable = __TS__Class()
local ServerVariable = ____exports.ServerVariable
ServerVariable.name = "ServerVariable"
function ServerVariable.prototype.____constructor(self, defaultValue, enums, description)
    self.default = defaultValue
    self.enum = enums
    self.description = description
end
return ____exports
 end,
["src.openapi.openapi3-ts.oas31"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
do
    local ____export = require("src.openapi.openapi3-ts.dsl.openapi-builder31")
    for ____exportKey, ____exportValue in pairs(____export) do
        if ____exportKey ~= "default" then
            ____exports[____exportKey] = ____exportValue
        end
    end
end
do
    local ____export = require("src.openapi.openapi3-ts.model.openapi31")
    for ____exportKey, ____exportValue in pairs(____export) do
        if ____exportKey ~= "default" then
            ____exports[____exportKey] = ____exportValue
        end
    end
end
do
    local ____server = require("src.openapi.openapi3-ts.model.server")
    local Server = ____server.Server
    local ServerVariable = ____server.ServerVariable
    ____exports.Server = Server
    ____exports.ServerVariable = ServerVariable
end
return ____exports
 end,
["src.openapi.openapi3-ts.index"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
____exports.oas31 = require("src.openapi.openapi3-ts.oas31")
do
    local ____server = require("src.openapi.openapi3-ts.model.server")
    local Server = ____server.Server
    local ServerVariable = ____server.ServerVariable
    ____exports.Server = Server
    ____exports.ServerVariable = ServerVariable
end
return ____exports
 end,
["src.services.coalition.service"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local __TS__New = ____lualib.__TS__New
local __TS__SourceMapTraceBack = ____lualib.__TS__SourceMapTraceBack
local ____exports = {}
____exports.CoalitionService = __TS__Class()
local CoalitionService = ____exports.CoalitionService
CoalitionService.name = "CoalitionService"
function CoalitionService.prototype.____constructor(self)
end
____exports.coalitionService = __TS__New(____exports.CoalitionService)
return ____exports
 end,
}
local __TS__SourceMapTraceBack = require("lualib_bundle").__TS__SourceMapTraceBack
__TS__SourceMapTraceBack(debug.getinfo(1).short_src, {["669"] = {line = 3, file = "cors.middleware.ts"},["670"] = {line = 4, file = "cors.middleware.ts"},["671"] = {line = 5, file = "cors.middleware.ts"},["672"] = {line = 9, file = "cors.middleware.ts"},["673"] = {line = 10, file = "cors.middleware.ts"},["674"] = {line = 3, file = "cors.middleware.ts"},["680"] = {line = 1, file = "package.json"},["681"] = {line = 2, file = "package.json"},["682"] = {line = 3, file = "package.json"},["683"] = {line = 4, file = "package.json"},["684"] = {line = 5, file = "package.json"},["685"] = {line = 6, file = "package.json"},["686"] = {line = 7, file = "package.json"},["687"] = {line = 8, file = "package.json"},["688"] = {line = 9, file = "package.json"},["689"] = {line = 10, file = "package.json"},["690"] = {line = 11, file = "package.json"},["691"] = {line = 12, file = "package.json"},["692"] = {line = 13, file = "package.json"},["693"] = {line = 5, file = "package.json"},["694"] = {line = 15, file = "package.json"},["695"] = {line = 16, file = "package.json"},["696"] = {line = 17, file = "package.json"},["697"] = {line = 18, file = "package.json"},["698"] = {line = 19, file = "package.json"},["699"] = {line = 20, file = "package.json"},["700"] = {line = 21, file = "package.json"},["701"] = {line = 22, file = "package.json"},["702"] = {line = 23, file = "package.json"},["703"] = {line = 24, file = "package.json"},["704"] = {line = 25, file = "package.json"},["705"] = {line = 18, file = "package.json"},["706"] = {line = 27, file = "package.json"},["707"] = {line = 28, file = "package.json"},["708"] = {line = 29, file = "package.json"},["709"] = {line = 30, file = "package.json"},["710"] = {line = 31, file = "package.json"},["711"] = {line = 32, file = "package.json"},["712"] = {line = 33, file = "package.json"},["713"] = {line = 34, file = "package.json"},["714"] = {line = 35, file = "package.json"},["715"] = {line = 36, file = "package.json"},["716"] = {line = 37, file = "package.json"},["717"] = {line = 38, file = "package.json"},["718"] = {line = 27, file = "package.json"},["719"] = {line = 1, file = "package.json"},["724"] = {line = 1, file = "dto.openapi.json"},["725"] = {line = 10, file = "dto.openapi.json"},["726"] = {line = 18, file = "dto.openapi.json"},["727"] = {line = 21, file = "dto.openapi.json"},["728"] = {line = 24, file = "dto.openapi.json"},["729"] = {line = 27, file = "dto.openapi.json"},["730"] = {line = 30, file = "dto.openapi.json"},["731"] = {line = 33, file = "dto.openapi.json"},["732"] = {line = 36, file = "dto.openapi.json"},["733"] = {line = 39, file = "dto.openapi.json"},["734"] = {line = 23, file = "dto.openapi.json"},["735"] = {line = 44, file = "dto.openapi.json"},["736"] = {line = 45, file = "dto.openapi.json"},["737"] = {line = 46, file = "dto.openapi.json"},["738"] = {line = 47, file = "dto.openapi.json"},["739"] = {line = 48, file = "dto.openapi.json"},["740"] = {line = 49, file = "dto.openapi.json"},["741"] = {line = 43, file = "dto.openapi.json"},["742"] = {line = 53, file = "dto.openapi.json"},["743"] = {line = 69, file = "dto.openapi.json"},["744"] = {line = 79, file = "dto.openapi.json"},["745"] = {line = 80, file = "dto.openapi.json"},["746"] = {line = 81, file = "dto.openapi.json"},["747"] = {line = 84, file = "dto.openapi.json"},["748"] = {line = 85, file = "dto.openapi.json"},["749"] = {line = 86, file = "dto.openapi.json"},["750"] = {line = 79, file = "dto.openapi.json"},["751"] = {line = 88, file = "dto.openapi.json"},["752"] = {line = 96, file = "dto.openapi.json"},["753"] = {line = 104, file = "dto.openapi.json"},["754"] = {line = 107, file = "dto.openapi.json"},["755"] = {line = 119, file = "dto.openapi.json"},["756"] = {line = 131, file = "dto.openapi.json"},["757"] = {line = 132, file = "dto.openapi.json"},["758"] = {line = 133, file = "dto.openapi.json"},["759"] = {line = 134, file = "dto.openapi.json"},["760"] = {line = 144, file = "dto.openapi.json"},["761"] = {line = 147, file = "dto.openapi.json"},["762"] = {line = 131, file = "dto.openapi.json"},["763"] = {line = 149, file = "dto.openapi.json"},["764"] = {line = 150, file = "dto.openapi.json"},["765"] = {line = 151, file = "dto.openapi.json"},["766"] = {line = 152, file = "dto.openapi.json"},["767"] = {line = 162, file = "dto.openapi.json"},["768"] = {line = 165, file = "dto.openapi.json"},["769"] = {line = 149, file = "dto.openapi.json"},["770"] = {line = 167, file = "dto.openapi.json"},["771"] = {line = 170, file = "dto.openapi.json"},["772"] = {line = 171, file = "dto.openapi.json"},["773"] = {line = 172, file = "dto.openapi.json"},["774"] = {line = 173, file = "dto.openapi.json"},["775"] = {line = 174, file = "dto.openapi.json"},["776"] = {line = 175, file = "dto.openapi.json"},["777"] = {line = 176, file = "dto.openapi.json"},["778"] = {line = 169, file = "dto.openapi.json"},["779"] = {line = 180, file = "dto.openapi.json"},["780"] = {line = 200, file = "dto.openapi.json"},["781"] = {line = 202, file = "dto.openapi.json"},["782"] = {line = 203, file = "dto.openapi.json"},["783"] = {line = 204, file = "dto.openapi.json"},["784"] = {line = 205, file = "dto.openapi.json"},["785"] = {line = 206, file = "dto.openapi.json"},["786"] = {line = 201, file = "dto.openapi.json"},["787"] = {line = 210, file = "dto.openapi.json"},["788"] = {line = 213, file = "dto.openapi.json"},["789"] = {line = 216, file = "dto.openapi.json"},["790"] = {line = 219, file = "dto.openapi.json"},["791"] = {line = 222, file = "dto.openapi.json"},["792"] = {line = 225, file = "dto.openapi.json"},["793"] = {line = 228, file = "dto.openapi.json"},["794"] = {line = 231, file = "dto.openapi.json"},["795"] = {line = 234, file = "dto.openapi.json"},["796"] = {line = 215, file = "dto.openapi.json"},["797"] = {line = 242, file = "dto.openapi.json"},["798"] = {line = 243, file = "dto.openapi.json"},["799"] = {line = 244, file = "dto.openapi.json"},["800"] = {line = 245, file = "dto.openapi.json"},["801"] = {line = 246, file = "dto.openapi.json"},["802"] = {line = 247, file = "dto.openapi.json"},["803"] = {line = 248, file = "dto.openapi.json"},["804"] = {line = 241, file = "dto.openapi.json"},["805"] = {line = 252, file = "dto.openapi.json"},["806"] = {line = 262, file = "dto.openapi.json"},["807"] = {line = 287, file = "dto.openapi.json"},["808"] = {line = 303, file = "dto.openapi.json"},["809"] = {line = 304, file = "dto.openapi.json"},["810"] = {line = 305, file = "dto.openapi.json"},["811"] = {line = 306, file = "dto.openapi.json"},["812"] = {line = 323, file = "dto.openapi.json"},["813"] = {line = 327, file = "dto.openapi.json"},["814"] = {line = 303, file = "dto.openapi.json"},["815"] = {line = 329, file = "dto.openapi.json"},["816"] = {line = 333, file = "dto.openapi.json"},["817"] = {line = 345, file = "dto.openapi.json"},["818"] = {line = 352, file = "dto.openapi.json"},["819"] = {line = 356, file = "dto.openapi.json"},["820"] = {line = 383, file = "dto.openapi.json"},["821"] = {line = 396, file = "dto.openapi.json"},["822"] = {line = 398, file = "dto.openapi.json"},["823"] = {line = 399, file = "dto.openapi.json"},["824"] = {line = 400, file = "dto.openapi.json"},["825"] = {line = 401, file = "dto.openapi.json"},["826"] = {line = 402, file = "dto.openapi.json"},["827"] = {line = 403, file = "dto.openapi.json"},["828"] = {line = 404, file = "dto.openapi.json"},["829"] = {line = 405, file = "dto.openapi.json"},["830"] = {line = 406, file = "dto.openapi.json"},["831"] = {line = 407, file = "dto.openapi.json"},["832"] = {line = 408, file = "dto.openapi.json"},["833"] = {line = 409, file = "dto.openapi.json"},["834"] = {line = 397, file = "dto.openapi.json"},["835"] = {line = 413, file = "dto.openapi.json"},["836"] = {line = 416, file = "dto.openapi.json"},["837"] = {line = 422, file = "dto.openapi.json"},["838"] = {line = 428, file = "dto.openapi.json"},["839"] = {line = 431, file = "dto.openapi.json"},["840"] = {line = 434, file = "dto.openapi.json"},["841"] = {line = 415, file = "dto.openapi.json"},["842"] = {line = 441, file = "dto.openapi.json"},["843"] = {line = 442, file = "dto.openapi.json"},["844"] = {line = 443, file = "dto.openapi.json"},["845"] = {line = 444, file = "dto.openapi.json"},["846"] = {line = 445, file = "dto.openapi.json"},["847"] = {line = 440, file = "dto.openapi.json"},["848"] = {line = 449, file = "dto.openapi.json"},["849"] = {line = 450, file = "dto.openapi.json"},["850"] = {line = 451, file = "dto.openapi.json"},["851"] = {line = 452, file = "dto.openapi.json"},["852"] = {line = 454, file = "dto.openapi.json"},["853"] = {line = 455, file = "dto.openapi.json"},["854"] = {line = 456, file = "dto.openapi.json"},["855"] = {line = 470, file = "dto.openapi.json"},["856"] = {line = 475, file = "dto.openapi.json"},["857"] = {line = 453, file = "dto.openapi.json"},["858"] = {line = 486, file = "dto.openapi.json"},["859"] = {line = 491, file = "dto.openapi.json"},["860"] = {line = 449, file = "dto.openapi.json"},["861"] = {line = 493, file = "dto.openapi.json"},["862"] = {line = 495, file = "dto.openapi.json"},["863"] = {line = 496, file = "dto.openapi.json"},["864"] = {line = 497, file = "dto.openapi.json"},["865"] = {line = 498, file = "dto.openapi.json"},["866"] = {line = 499, file = "dto.openapi.json"},["867"] = {line = 494, file = "dto.openapi.json"},["868"] = {line = 503, file = "dto.openapi.json"},["869"] = {line = 506, file = "dto.openapi.json"},["870"] = {line = 509, file = "dto.openapi.json"},["871"] = {line = 512, file = "dto.openapi.json"},["872"] = {line = 535, file = "dto.openapi.json"},["873"] = {line = 538, file = "dto.openapi.json"},["874"] = {line = 541, file = "dto.openapi.json"},["875"] = {line = 544, file = "dto.openapi.json"},["876"] = {line = 547, file = "dto.openapi.json"},["877"] = {line = 550, file = "dto.openapi.json"},["878"] = {line = 553, file = "dto.openapi.json"},["879"] = {line = 556, file = "dto.openapi.json"},["880"] = {line = 559, file = "dto.openapi.json"},["881"] = {line = 562, file = "dto.openapi.json"},["882"] = {line = 565, file = "dto.openapi.json"},["883"] = {line = 568, file = "dto.openapi.json"},["884"] = {line = 508, file = "dto.openapi.json"},["885"] = {line = 573, file = "dto.openapi.json"},["886"] = {line = 574, file = "dto.openapi.json"},["887"] = {line = 575, file = "dto.openapi.json"},["888"] = {line = 576, file = "dto.openapi.json"},["889"] = {line = 577, file = "dto.openapi.json"},["890"] = {line = 578, file = "dto.openapi.json"},["891"] = {line = 579, file = "dto.openapi.json"},["892"] = {line = 580, file = "dto.openapi.json"},["893"] = {line = 581, file = "dto.openapi.json"},["894"] = {line = 582, file = "dto.openapi.json"},["895"] = {line = 583, file = "dto.openapi.json"},["896"] = {line = 584, file = "dto.openapi.json"},["897"] = {line = 585, file = "dto.openapi.json"},["898"] = {line = 586, file = "dto.openapi.json"},["899"] = {line = 572, file = "dto.openapi.json"},["900"] = {line = 590, file = "dto.openapi.json"},["901"] = {line = 606, file = "dto.openapi.json"},["902"] = {line = 638, file = "dto.openapi.json"},["903"] = {line = 9, file = "dto.openapi.json"},["918"] = {line = 15, file = "specification-extension.ts"},["919"] = {line = 15, file = "specification-extension.ts"},["920"] = {line = 15, file = "specification-extension.ts"},["922"] = {line = 15, file = "specification-extension.ts"},["923"] = {line = 18, file = "specification-extension.ts"},["924"] = {line = 19, file = "specification-extension.ts"},["925"] = {line = 18, file = "specification-extension.ts"},["926"] = {line = 22, file = "specification-extension.ts"},["927"] = {line = 23, file = "specification-extension.ts"},["929"] = {line = 24, file = "specification-extension.ts"},["933"] = {line = 28, file = "specification-extension.ts"},["934"] = {line = 29, file = "specification-extension.ts"},["936"] = {line = 31, file = "specification-extension.ts"},["937"] = {line = 22, file = "specification-extension.ts"},["938"] = {line = 33, file = "specification-extension.ts"},["939"] = {line = 34, file = "specification-extension.ts"},["941"] = {line = 35, file = "specification-extension.ts"},["945"] = {line = 39, file = "specification-extension.ts"},["946"] = {line = 33, file = "specification-extension.ts"},["947"] = {line = 41, file = "specification-extension.ts"},["948"] = {line = 42, file = "specification-extension.ts"},["949"] = {line = 43, file = "specification-extension.ts"},["950"] = {line = 44, file = "specification-extension.ts"},["951"] = {line = 45, file = "specification-extension.ts"},["952"] = {line = 46, file = "specification-extension.ts"},["956"] = {line = 50, file = "specification-extension.ts"},["957"] = {line = 41, file = "specification-extension.ts"},["964"] = {line = 3, file = "oas-common.ts"},["965"] = {line = 6, file = "oas-common.ts"},["966"] = {line = 20, file = "oas-common.ts"},["967"] = {line = 24, file = "oas-common.ts"},["968"] = {line = 25, file = "oas-common.ts"},["970"] = {line = 27, file = "oas-common.ts"},["971"] = {line = 28, file = "oas-common.ts"},["973"] = {line = 30, file = "oas-common.ts"},["974"] = {line = 20, file = "oas-common.ts"},["975"] = {line = 32, file = "oas-common.ts"},["976"] = {line = 37, file = "oas-common.ts"},["977"] = {line = 38, file = "oas-common.ts"},["979"] = {line = 32, file = "oas-common.ts"},["986"] = {line = 7, file = "openapi31.ts"},["987"] = {line = 9, file = "openapi31.ts"},["989"] = {line = 12, file = "openapi31.ts"},["996"] = {line = 78, file = "openapi31.ts"},["997"] = {line = 82, file = "openapi31.ts"},["998"] = {line = 83, file = "openapi31.ts"},["1000"] = {line = 85, file = "openapi31.ts"},["1001"] = {line = 78, file = "openapi31.ts"},["1006"] = {line = 262, file = "openapi31.ts"},["1007"] = {line = 263, file = "openapi31.ts"},["1008"] = {line = 262, file = "openapi31.ts"},["1016"] = {line = 339, file = "openapi31.ts"},["1017"] = {line = 342, file = "openapi31.ts"},["1018"] = {line = 339, file = "openapi31.ts"},["1028"] = {line = 6, file = "openapi-builder31.ts"},["1029"] = {line = 6, file = "openapi-builder31.ts"},["1030"] = {line = 6, file = "openapi-builder31.ts"},["1031"] = {line = 13, file = "openapi-builder31.ts"},["1032"] = {line = 14, file = "openapi-builder31.ts"},["1033"] = {line = 15, file = "openapi-builder31.ts"},["1034"] = {line = 16, file = "openapi-builder31.ts"},["1035"] = {line = 20, file = "openapi-builder31.ts"},["1036"] = {line = 21, file = "openapi-builder31.ts"},["1037"] = {line = 22, file = "openapi-builder31.ts"},["1038"] = {line = 23, file = "openapi-builder31.ts"},["1039"] = {line = 24, file = "openapi-builder31.ts"},["1040"] = {line = 25, file = "openapi-builder31.ts"},["1041"] = {line = 26, file = "openapi-builder31.ts"},["1042"] = {line = 27, file = "openapi-builder31.ts"},["1043"] = {line = 28, file = "openapi-builder31.ts"},["1044"] = {line = 29, file = "openapi-builder31.ts"},["1045"] = {line = 30, file = "openapi-builder31.ts"},["1046"] = {line = 21, file = "openapi-builder31.ts"},["1047"] = {line = 32, file = "openapi-builder31.ts"},["1048"] = {line = 33, file = "openapi-builder31.ts"},["1049"] = {line = 14, file = "openapi-builder31.ts"},["1050"] = {line = 13, file = "openapi-builder31.ts"},["1051"] = {line = 9, file = "openapi-builder31.ts"},["1052"] = {line = 10, file = "openapi-builder31.ts"},["1053"] = {line = 9, file = "openapi-builder31.ts"},["1054"] = {line = 37, file = "openapi-builder31.ts"},["1055"] = {line = 38, file = "openapi-builder31.ts"},["1056"] = {line = 37, file = "openapi-builder31.ts"},["1057"] = {line = 41, file = "openapi-builder31.ts"},["1058"] = {line = 42, file = "openapi-builder31.ts"},["1059"] = {line = 43, file = "openapi-builder31.ts"},["1060"] = {line = 41, file = "openapi-builder31.ts"},["1061"] = {line = 45, file = "openapi-builder31.ts"},["1062"] = {line = 46, file = "openapi-builder31.ts"},["1063"] = {line = 47, file = "openapi-builder31.ts"},["1064"] = {line = 45, file = "openapi-builder31.ts"},["1065"] = {line = 49, file = "openapi-builder31.ts"},["1066"] = {line = 50, file = "openapi-builder31.ts"},["1067"] = {line = 51, file = "openapi-builder31.ts"},["1068"] = {line = 49, file = "openapi-builder31.ts"},["1069"] = {line = 53, file = "openapi-builder31.ts"},["1070"] = {line = 54, file = "openapi-builder31.ts"},["1071"] = {line = 55, file = "openapi-builder31.ts"},["1072"] = {line = 53, file = "openapi-builder31.ts"},["1073"] = {line = 57, file = "openapi-builder31.ts"},["1074"] = {line = 58, file = "openapi-builder31.ts"},["1075"] = {line = 59, file = "openapi-builder31.ts"},["1076"] = {line = 57, file = "openapi-builder31.ts"},["1077"] = {line = 61, file = "openapi-builder31.ts"},["1078"] = {line = 62, file = "openapi-builder31.ts"},["1079"] = {line = 63, file = "openapi-builder31.ts"},["1080"] = {line = 61, file = "openapi-builder31.ts"},["1081"] = {line = 65, file = "openapi-builder31.ts"},["1082"] = {line = 66, file = "openapi-builder31.ts"},["1083"] = {line = 67, file = "openapi-builder31.ts"},["1084"] = {line = 65, file = "openapi-builder31.ts"},["1085"] = {line = 69, file = "openapi-builder31.ts"},["1086"] = {line = 70, file = "openapi-builder31.ts"},["1087"] = {line = 71, file = "openapi-builder31.ts"},["1088"] = {line = 69, file = "openapi-builder31.ts"},["1089"] = {line = 73, file = "openapi-builder31.ts"},["1090"] = {line = 74, file = "openapi-builder31.ts"},["1091"] = {line = 75, file = "openapi-builder31.ts"},["1092"] = {line = 79, file = "openapi-builder31.ts"},["1093"] = {line = 73, file = "openapi-builder31.ts"},["1094"] = {line = 81, file = "openapi-builder31.ts"},["1095"] = {line = 85, file = "openapi-builder31.ts"},["1096"] = {line = 86, file = "openapi-builder31.ts"},["1097"] = {line = 87, file = "openapi-builder31.ts"},["1098"] = {line = 88, file = "openapi-builder31.ts"},["1099"] = {line = 81, file = "openapi-builder31.ts"},["1100"] = {line = 90, file = "openapi-builder31.ts"},["1101"] = {line = 94, file = "openapi-builder31.ts"},["1102"] = {line = 95, file = "openapi-builder31.ts"},["1103"] = {line = 96, file = "openapi-builder31.ts"},["1104"] = {line = 97, file = "openapi-builder31.ts"},["1105"] = {line = 90, file = "openapi-builder31.ts"},["1106"] = {line = 99, file = "openapi-builder31.ts"},["1107"] = {line = 103, file = "openapi-builder31.ts"},["1108"] = {line = 104, file = "openapi-builder31.ts"},["1109"] = {line = 106, file = "openapi-builder31.ts"},["1110"] = {line = 107, file = "openapi-builder31.ts"},["1111"] = {line = 99, file = "openapi-builder31.ts"},["1112"] = {line = 109, file = "openapi-builder31.ts"},["1113"] = {line = 113, file = "openapi-builder31.ts"},["1114"] = {line = 114, file = "openapi-builder31.ts"},["1115"] = {line = 115, file = "openapi-builder31.ts"},["1116"] = {line = 116, file = "openapi-builder31.ts"},["1117"] = {line = 109, file = "openapi-builder31.ts"},["1118"] = {line = 118, file = "openapi-builder31.ts"},["1119"] = {line = 122, file = "openapi-builder31.ts"},["1120"] = {line = 123, file = "openapi-builder31.ts"},["1121"] = {line = 125, file = "openapi-builder31.ts"},["1122"] = {line = 126, file = "openapi-builder31.ts"},["1123"] = {line = 118, file = "openapi-builder31.ts"},["1124"] = {line = 128, file = "openapi-builder31.ts"},["1125"] = {line = 132, file = "openapi-builder31.ts"},["1126"] = {line = 133, file = "openapi-builder31.ts"},["1127"] = {line = 134, file = "openapi-builder31.ts"},["1128"] = {line = 135, file = "openapi-builder31.ts"},["1129"] = {line = 128, file = "openapi-builder31.ts"},["1130"] = {line = 137, file = "openapi-builder31.ts"},["1131"] = {line = 141, file = "openapi-builder31.ts"},["1132"] = {line = 142, file = "openapi-builder31.ts"},["1133"] = {line = 144, file = "openapi-builder31.ts"},["1134"] = {line = 145, file = "openapi-builder31.ts"},["1135"] = {line = 137, file = "openapi-builder31.ts"},["1136"] = {line = 147, file = "openapi-builder31.ts"},["1137"] = {line = 151, file = "openapi-builder31.ts"},["1138"] = {line = 152, file = "openapi-builder31.ts"},["1139"] = {line = 153, file = "openapi-builder31.ts"},["1140"] = {line = 154, file = "openapi-builder31.ts"},["1141"] = {line = 147, file = "openapi-builder31.ts"},["1142"] = {line = 156, file = "openapi-builder31.ts"},["1143"] = {line = 160, file = "openapi-builder31.ts"},["1144"] = {line = 161, file = "openapi-builder31.ts"},["1145"] = {line = 162, file = "openapi-builder31.ts"},["1146"] = {line = 163, file = "openapi-builder31.ts"},["1147"] = {line = 156, file = "openapi-builder31.ts"},["1148"] = {line = 165, file = "openapi-builder31.ts"},["1149"] = {line = 166, file = "openapi-builder31.ts"},["1150"] = {line = 167, file = "openapi-builder31.ts"},["1151"] = {line = 167, file = "openapi-builder31.ts"},["1152"] = {line = 168, file = "openapi-builder31.ts"},["1153"] = {line = 165, file = "openapi-builder31.ts"},["1154"] = {line = 170, file = "openapi-builder31.ts"},["1155"] = {line = 171, file = "openapi-builder31.ts"},["1156"] = {line = 172, file = "openapi-builder31.ts"},["1157"] = {line = 172, file = "openapi-builder31.ts"},["1158"] = {line = 173, file = "openapi-builder31.ts"},["1159"] = {line = 170, file = "openapi-builder31.ts"},["1160"] = {line = 175, file = "openapi-builder31.ts"},["1161"] = {line = 176, file = "openapi-builder31.ts"},["1162"] = {line = 177, file = "openapi-builder31.ts"},["1163"] = {line = 175, file = "openapi-builder31.ts"},["1164"] = {line = 179, file = "openapi-builder31.ts"},["1165"] = {line = 180, file = "openapi-builder31.ts"},["1166"] = {line = 180, file = "openapi-builder31.ts"},["1167"] = {line = 180, file = "openapi-builder31.ts"},["1169"] = {line = 181, file = "openapi-builder31.ts"},["1170"] = {line = 182, file = "openapi-builder31.ts"},["1171"] = {line = 179, file = "openapi-builder31.ts"},["1182"] = {line = 4, file = "utils.ts"},["1183"] = {line = 7, file = "utils.ts"},["1184"] = {line = 9, file = "utils.ts"},["1185"] = {line = 9, file = "utils.ts"},["1186"] = {line = 9, file = "utils.ts"},["1187"] = {line = 10, file = "utils.ts"},["1188"] = {line = 11, file = "utils.ts"},["1189"] = {line = 12, file = "utils.ts"},["1192"] = {line = 13, file = "utils.ts"},["1193"] = {line = 14, file = "utils.ts"},["1194"] = {line = 9, file = "utils.ts"},["1195"] = {line = 9, file = "utils.ts"},["1196"] = {line = 24, file = "utils.ts"},["1197"] = {line = 4, file = "utils.ts"},["1198"] = {line = 27, file = "utils.ts"},["1205"] = {line = 1, file = "index.ts"},["1206"] = {line = 1, file = "index.ts"},["1207"] = {line = 2, file = "index.ts"},["1208"] = {line = 3, file = "index.ts"},["1209"] = {line = 3, file = "index.ts"},["1211"] = {line = 6, file = "index.ts"},["1218"] = {line = 8, file = "index.ts"},["1226"] = {line = 1, file = "app.ts"},["1227"] = {line = 1, file = "app.ts"},["1228"] = {line = 2, file = "app.ts"},["1229"] = {line = 2, file = "app.ts"},["1230"] = {line = 3, file = "app.ts"},["1231"] = {line = 3, file = "app.ts"},["1232"] = {line = 4, file = "app.ts"},["1233"] = {line = 4, file = "app.ts"},["1234"] = {line = 7, file = "app.ts"},["1235"] = {line = 9, file = "app.ts"},["1236"] = {line = 10, file = "app.ts"},["1237"] = {line = 11, file = "app.ts"},["1238"] = {line = 9, file = "app.ts"},["1239"] = {line = 14, file = "app.ts"},["1240"] = {line = 15, file = "app.ts"},["1241"] = {line = 16, file = "app.ts"},["1242"] = {line = 14, file = "app.ts"},["1243"] = {line = 19, file = "app.ts"},["1244"] = {line = 24, file = "app.ts"},["1245"] = {line = 24, file = "app.ts"},["1246"] = {line = 24, file = "app.ts"},["1247"] = {line = 24, file = "app.ts"},["1248"] = {line = 25, file = "app.ts"},["1249"] = {line = 26, file = "app.ts"},["1250"] = {line = 19, file = "app.ts"},["1251"] = {line = 29, file = "app.ts"},["1252"] = {line = 34, file = "app.ts"},["1253"] = {line = 34, file = "app.ts"},["1254"] = {line = 34, file = "app.ts"},["1255"] = {line = 34, file = "app.ts"},["1256"] = {line = 35, file = "app.ts"},["1257"] = {line = 36, file = "app.ts"},["1258"] = {line = 29, file = "app.ts"},["3174"] = {line = 1, file = "api-docs.ts"},["3175"] = {line = 1, file = "api-docs.ts"},["3176"] = {line = 2, file = "api-docs.ts"},["3177"] = {line = 2, file = "api-docs.ts"},["3178"] = {line = 4, file = "api-docs.ts"},["3179"] = {line = 4, file = "api-docs.ts"},["3180"] = {line = 4, file = "api-docs.ts"},["3181"] = {line = 5, file = "api-docs.ts"},["3182"] = {line = 4, file = "api-docs.ts"},["3183"] = {line = 4, file = "api-docs.ts"},["3196"] = {line = 3, file = "vectors.ts"},["3197"] = {line = 4, file = "vectors.ts"},["3198"] = {line = 4, file = "vectors.ts"},["3199"] = {line = 4, file = "vectors.ts"},["3200"] = {line = 4, file = "vectors.ts"},["3201"] = {line = 5, file = "vectors.ts"},["3202"] = {line = 3, file = "vectors.ts"},["3214"] = {line = 3, file = "geo.service.ts"},["3215"] = {line = 3, file = "geo.service.ts"},["3216"] = {line = 5, file = "geo.service.ts"},["3217"] = {line = 5, file = "geo.service.ts"},["3218"] = {line = 5, file = "geo.service.ts"},["3220"] = {line = 5, file = "geo.service.ts"},["3221"] = {line = 6, file = "geo.service.ts"},["3222"] = {line = 7, file = "geo.service.ts"},["3223"] = {line = 8, file = "geo.service.ts"},["3224"] = {line = 6, file = "geo.service.ts"},["3225"] = {line = 11, file = "geo.service.ts"},["3226"] = {line = 12, file = "geo.service.ts"},["3227"] = {line = 11, file = "geo.service.ts"},["3228"] = {line = 15, file = "geo.service.ts"},["3229"] = {line = 16, file = "geo.service.ts"},["3230"] = {line = 15, file = "geo.service.ts"},["3231"] = {line = 19, file = "geo.service.ts"},["3232"] = {line = 20, file = "geo.service.ts"},["3233"] = {line = 20, file = "geo.service.ts"},["3234"] = {line = 20, file = "geo.service.ts"},["3235"] = {line = 20, file = "geo.service.ts"},["3236"] = {line = 19, file = "geo.service.ts"},["3237"] = {line = 23, file = "geo.service.ts"},["3238"] = {line = 24, file = "geo.service.ts"},["3239"] = {line = 25, file = "geo.service.ts"},["3240"] = {line = 26, file = "geo.service.ts"},["3241"] = {line = 27, file = "geo.service.ts"},["3242"] = {line = 28, file = "geo.service.ts"},["3243"] = {line = 29, file = "geo.service.ts"},["3244"] = {line = 30, file = "geo.service.ts"},["3245"] = {line = 31, file = "geo.service.ts"},["3246"] = {line = 26, file = "geo.service.ts"},["3247"] = {line = 33, file = "geo.service.ts"},["3248"] = {line = 33, file = "geo.service.ts"},["3249"] = {line = 33, file = "geo.service.ts"},["3250"] = {line = 33, file = "geo.service.ts"},["3251"] = {line = 23, file = "geo.service.ts"},["3252"] = {line = 36, file = "geo.service.ts"},["3253"] = {line = 37, file = "geo.service.ts"},["3254"] = {line = 39, file = "geo.service.ts"},["3255"] = {line = 39, file = "geo.service.ts"},["3256"] = {line = 39, file = "geo.service.ts"},["3257"] = {line = 40, file = "geo.service.ts"},["3258"] = {line = 41, file = "geo.service.ts"},["3260"] = {line = 43, file = "geo.service.ts"},["3261"] = {line = 44, file = "geo.service.ts"},["3262"] = {line = 44, file = "geo.service.ts"},["3263"] = {line = 44, file = "geo.service.ts"},["3264"] = {line = 44, file = "geo.service.ts"},["3266"] = {line = 39, file = "geo.service.ts"},["3267"] = {line = 39, file = "geo.service.ts"},["3268"] = {line = 48, file = "geo.service.ts"},["3269"] = {line = 50, file = "geo.service.ts"},["3270"] = {line = 36, file = "geo.service.ts"},["3271"] = {line = 53, file = "geo.service.ts"},["3272"] = {line = 54, file = "geo.service.ts"},["3273"] = {line = 53, file = "geo.service.ts"},["3274"] = {line = 58, file = "geo.service.ts"},["3282"] = {line = 1, file = "camera.ts"},["3283"] = {line = 1, file = "camera.ts"},["3284"] = {line = 3, file = "camera.ts"},["3285"] = {line = 3, file = "camera.ts"},["3286"] = {line = 5, file = "camera.ts"},["3287"] = {line = 6, file = "camera.ts"},["3288"] = {line = 6, file = "camera.ts"},["3289"] = {line = 8, file = "camera.ts"},["3290"] = {line = 8, file = "camera.ts"},["3291"] = {line = 8, file = "camera.ts"},["3292"] = {line = 9, file = "camera.ts"},["3293"] = {line = 9, file = "camera.ts"},["3294"] = {line = 11, file = "camera.ts"},["3295"] = {line = 13, file = "camera.ts"},["3296"] = {line = 14, file = "camera.ts"},["3297"] = {line = 15, file = "camera.ts"},["3298"] = {line = 16, file = "camera.ts"},["3299"] = {line = 17, file = "camera.ts"},["3300"] = {line = 18, file = "camera.ts"},["3301"] = {line = 19, file = "camera.ts"},["3302"] = {line = 20, file = "camera.ts"},["3303"] = {line = 13, file = "camera.ts"},["3304"] = {line = 23, file = "camera.ts"},["3305"] = {line = 30, file = "camera.ts"},["3306"] = {line = 31, file = "camera.ts"},["3307"] = {line = 32, file = "camera.ts"},["3308"] = {line = 34, file = "camera.ts"},["3309"] = {line = 40, file = "camera.ts"},["3310"] = {line = 41, file = "camera.ts"},["3311"] = {line = 42, file = "camera.ts"},["3312"] = {line = 44, file = "camera.ts"},["3313"] = {line = 23, file = "camera.ts"},["3314"] = {line = 47, file = "camera.ts"},["3315"] = {line = 47, file = "camera.ts"},["3316"] = {line = 48, file = "camera.ts"},["3317"] = {line = 49, file = "camera.ts"},["3318"] = {line = 50, file = "camera.ts"},["3319"] = {line = 51, file = "camera.ts"},["3320"] = {line = 52, file = "camera.ts"},["3321"] = {line = 49, file = "camera.ts"},["3322"] = {line = 56, file = "camera.ts"},["3323"] = {line = 57, file = "camera.ts"},["3324"] = {line = 58, file = "camera.ts"},["3325"] = {line = 58, file = "camera.ts"},["3326"] = {line = 58, file = "camera.ts"},["3327"] = {line = 58, file = "camera.ts"},["3328"] = {line = 58, file = "camera.ts"},["3329"] = {line = 61, file = "camera.ts"},["3330"] = {line = 69, file = "camera.ts"},["3331"] = {line = 70, file = "camera.ts"},["3332"] = {line = 71, file = "camera.ts"},["3333"] = {line = 71, file = "camera.ts"},["3334"] = {line = 71, file = "camera.ts"},["3335"] = {line = 71, file = "camera.ts"},["3336"] = {line = 71, file = "camera.ts"},["3337"] = {line = 71, file = "camera.ts"},["3338"] = {line = 71, file = "camera.ts"},["3339"] = {line = 73, file = "camera.ts"},["3342"] = {line = 84, file = "camera.ts"},["3343"] = {line = 85, file = "camera.ts"},["3344"] = {line = 86, file = "camera.ts"},["3347"] = {line = 76, file = "camera.ts"},["3348"] = {line = 76, file = "camera.ts"},["3349"] = {line = 76, file = "camera.ts"},["3350"] = {line = 77, file = "camera.ts"},["3351"] = {line = 78, file = "camera.ts"},["3352"] = {line = 79, file = "camera.ts"},["3353"] = {line = 77, file = "camera.ts"},["3359"] = {line = 56, file = "camera.ts"},["3360"] = {line = 47, file = "camera.ts"},["3957"] = {line = 6, file = "lookups.ts"},["3958"] = {line = 12, file = "lookups.ts"},["3959"] = {line = 13, file = "lookups.ts"},["3960"] = {line = 14, file = "lookups.ts"},["3961"] = {line = 15, file = "lookups.ts"},["3962"] = {line = 16, file = "lookups.ts"},["3963"] = {line = 17, file = "lookups.ts"},["3964"] = {line = 12, file = "lookups.ts"},["3965"] = {line = 20, file = "lookups.ts"},["3966"] = {line = 21, file = "lookups.ts"},["3967"] = {line = 22, file = "lookups.ts"},["3968"] = {line = 23, file = "lookups.ts"},["3969"] = {line = 24, file = "lookups.ts"},["3970"] = {line = 25, file = "lookups.ts"},["3971"] = {line = 20, file = "lookups.ts"},["3972"] = {line = 28, file = "lookups.ts"},["3990"] = {line = 4, file = "wr-unit.ts"},["3991"] = {line = 4, file = "wr-unit.ts"},["3992"] = {line = 8, file = "wr-unit.ts"},["3993"] = {line = 8, file = "wr-unit.ts"},["3994"] = {line = 8, file = "wr-unit.ts"},["3995"] = {line = 37, file = "wr-unit.ts"},["3996"] = {line = 37, file = "wr-unit.ts"},["3997"] = {line = 37, file = "wr-unit.ts"},["3998"] = {line = 119, file = "wr-unit.ts"},["3999"] = {line = 119, file = "wr-unit.ts"},["4000"] = {line = 119, file = "wr-unit.ts"},["4001"] = {line = 121, file = "wr-unit.ts"},["4002"] = {line = 122, file = "wr-unit.ts"},["4003"] = {line = 123, file = "wr-unit.ts"},["4004"] = {line = 124, file = "wr-unit.ts"},["4005"] = {line = 125, file = "wr-unit.ts"},["4006"] = {line = 126, file = "wr-unit.ts"},["4007"] = {line = 127, file = "wr-unit.ts"},["4008"] = {line = 128, file = "wr-unit.ts"},["4009"] = {line = 129, file = "wr-unit.ts"},["4010"] = {line = 130, file = "wr-unit.ts"},["4011"] = {line = 131, file = "wr-unit.ts"},["4012"] = {line = 132, file = "wr-unit.ts"},["4013"] = {line = 133, file = "wr-unit.ts"},["4014"] = {line = 134, file = "wr-unit.ts"},["4015"] = {line = 135, file = "wr-unit.ts"},["4016"] = {line = 136, file = "wr-unit.ts"},["4017"] = {line = 122, file = "wr-unit.ts"},["4018"] = {line = 121, file = "wr-unit.ts"},["4023"] = {line = 39, file = "wr-unit.ts"},["4031"] = {line = 43, file = "wr-unit.ts"},["4039"] = {line = 47, file = "wr-unit.ts"},["4047"] = {line = 51, file = "wr-unit.ts"},["4055"] = {line = 55, file = "wr-unit.ts"},["4063"] = {line = 59, file = "wr-unit.ts"},["4071"] = {line = 63, file = "wr-unit.ts"},["4079"] = {line = 67, file = "wr-unit.ts"},["4087"] = {line = 71, file = "wr-unit.ts"},["4095"] = {line = 75, file = "wr-unit.ts"},["4096"] = {line = 76, file = "wr-unit.ts"},["4097"] = {line = 77, file = "wr-unit.ts"},["4098"] = {line = 75, file = "wr-unit.ts"},["4106"] = {line = 82, file = "wr-unit.ts"},["4114"] = {line = 86, file = "wr-unit.ts"},["4115"] = {line = 87, file = "wr-unit.ts"},["4123"] = {line = 91, file = "wr-unit.ts"},["4131"] = {line = 95, file = "wr-unit.ts"},["4132"] = {line = 97, file = "wr-unit.ts"},["4133"] = {line = 96, file = "wr-unit.ts"},["4134"] = {line = 97, file = "wr-unit.ts"},["4135"] = {line = 97, file = "wr-unit.ts"},["4136"] = {line = 97, file = "wr-unit.ts"},["4144"] = {line = 106, file = "wr-unit.ts"},["4152"] = {line = 110, file = "wr-unit.ts"},["4160"] = {line = 115, file = "wr-unit.ts"},["4161"] = {line = 115, file = "wr-unit.ts"},["4162"] = {line = 115, file = "wr-unit.ts"},["4163"] = {line = 115, file = "wr-unit.ts"},["4164"] = {line = 114, file = "wr-unit.ts"},["4180"] = {line = 4, file = "wr-group.ts"},["4181"] = {line = 4, file = "wr-group.ts"},["4182"] = {line = 7, file = "wr-group.ts"},["4183"] = {line = 7, file = "wr-group.ts"},["4184"] = {line = 7, file = "wr-group.ts"},["4185"] = {line = 8, file = "wr-group.ts"},["4186"] = {line = 8, file = "wr-group.ts"},["4187"] = {line = 10, file = "wr-group.ts"},["4188"] = {line = 10, file = "wr-group.ts"},["4189"] = {line = 10, file = "wr-group.ts"},["4190"] = {line = 42, file = "wr-group.ts"},["4191"] = {line = 42, file = "wr-group.ts"},["4192"] = {line = 42, file = "wr-group.ts"},["4193"] = {line = 44, file = "wr-group.ts"},["4194"] = {line = 45, file = "wr-group.ts"},["4195"] = {line = 44, file = "wr-group.ts"},["4196"] = {line = 48, file = "wr-group.ts"},["4197"] = {line = 49, file = "wr-group.ts"},["4198"] = {line = 50, file = "wr-group.ts"},["4199"] = {line = 51, file = "wr-group.ts"},["4200"] = {line = 52, file = "wr-group.ts"},["4201"] = {line = 53, file = "wr-group.ts"},["4202"] = {line = 54, file = "wr-group.ts"},["4203"] = {line = 55, file = "wr-group.ts"},["4204"] = {line = 55, file = "wr-group.ts"},["4205"] = {line = 55, file = "wr-group.ts"},["4206"] = {line = 55, file = "wr-group.ts"},["4207"] = {line = 56, file = "wr-group.ts"},["4208"] = {line = 56, file = "wr-group.ts"},["4209"] = {line = 57, file = "wr-group.ts"},["4210"] = {line = 58, file = "wr-group.ts"},["4211"] = {line = 59, file = "wr-group.ts"},["4212"] = {line = 60, file = "wr-group.ts"},["4213"] = {line = 61, file = "wr-group.ts"},["4214"] = {line = 62, file = "wr-group.ts"},["4215"] = {line = 63, file = "wr-group.ts"},["4216"] = {line = 64, file = "wr-group.ts"},["4217"] = {line = 65, file = "wr-group.ts"},["4218"] = {line = 66, file = "wr-group.ts"},["4219"] = {line = 67, file = "wr-group.ts"},["4220"] = {line = 68, file = "wr-group.ts"},["4221"] = {line = 69, file = "wr-group.ts"},["4222"] = {line = 70, file = "wr-group.ts"},["4223"] = {line = 71, file = "wr-group.ts"},["4224"] = {line = 57, file = "wr-group.ts"},["4225"] = {line = 56, file = "wr-group.ts"},["4226"] = {line = 49, file = "wr-group.ts"},["4227"] = {line = 48, file = "wr-group.ts"},["4232"] = {line = 12, file = "wr-group.ts"},["4240"] = {line = 15, file = "wr-group.ts"},["4248"] = {line = 19, file = "wr-group.ts"},["4256"] = {line = 23, file = "wr-group.ts"},["4264"] = {line = 27, file = "wr-group.ts"},["4272"] = {line = 31, file = "wr-group.ts"},["4280"] = {line = 35, file = "wr-group.ts"},["4288"] = {line = 39, file = "wr-group.ts"},["4289"] = {line = 39, file = "wr-group.ts"},["4290"] = {line = 39, file = "wr-group.ts"},["4291"] = {line = 39, file = "wr-group.ts"},["4305"] = {line = 2, file = "wr-airplane-group.ts"},["4306"] = {line = 2, file = "wr-airplane-group.ts"},["4307"] = {line = 6, file = "wr-airplane-group.ts"},["4308"] = {line = 6, file = "wr-airplane-group.ts"},["4309"] = {line = 8, file = "wr-airplane-group.ts"},["4310"] = {line = 8, file = "wr-airplane-group.ts"},["4311"] = {line = 8, file = "wr-airplane-group.ts"},["4312"] = {line = 8, file = "wr-airplane-group.ts"},["4313"] = {line = 9, file = "wr-airplane-group.ts"},["4314"] = {line = 8, file = "wr-airplane-group.ts"},["4315"] = {line = 9, file = "wr-airplane-group.ts"},["4316"] = {line = 13, file = "wr-airplane-group.ts"},["4317"] = {line = 14, file = "wr-airplane-group.ts"},["4318"] = {line = 15, file = "wr-airplane-group.ts"},["4319"] = {line = 16, file = "wr-airplane-group.ts"},["4320"] = {line = 17, file = "wr-airplane-group.ts"},["4321"] = {line = 19, file = "wr-airplane-group.ts"},["4322"] = {line = 19, file = "wr-airplane-group.ts"},["4324"] = {line = 20, file = "wr-airplane-group.ts"},["4325"] = {line = 21, file = "wr-airplane-group.ts"},["4326"] = {line = 22, file = "wr-airplane-group.ts"},["4327"] = {line = 23, file = "wr-airplane-group.ts"},["4328"] = {line = 24, file = "wr-airplane-group.ts"},["4329"] = {line = 25, file = "wr-airplane-group.ts"},["4330"] = {line = 26, file = "wr-airplane-group.ts"},["4331"] = {line = 27, file = "wr-airplane-group.ts"},["4332"] = {line = 28, file = "wr-airplane-group.ts"},["4333"] = {line = 29, file = "wr-airplane-group.ts"},["4334"] = {line = 19, file = "wr-airplane-group.ts"},["4335"] = {line = 35, file = "wr-airplane-group.ts"},["4336"] = {line = 19, file = "wr-airplane-group.ts"},["4337"] = {line = 19, file = "wr-airplane-group.ts"},["4338"] = {line = 15, file = "wr-airplane-group.ts"},["4339"] = {line = 13, file = "wr-airplane-group.ts"},["4357"] = {line = 5, file = "wr-airbase.ts"},["4358"] = {line = 5, file = "wr-airbase.ts"},["4359"] = {line = 5, file = "wr-airbase.ts"},["4360"] = {line = 7, file = "wr-airbase.ts"},["4361"] = {line = 7, file = "wr-airbase.ts"},["4362"] = {line = 7, file = "wr-airbase.ts"},["4363"] = {line = 56, file = "wr-airbase.ts"},["4364"] = {line = 56, file = "wr-airbase.ts"},["4365"] = {line = 56, file = "wr-airbase.ts"},["4370"] = {line = 9, file = "wr-airbase.ts"},["4378"] = {line = 13, file = "wr-airbase.ts"},["4386"] = {line = 17, file = "wr-airbase.ts"},["4394"] = {line = 21, file = "wr-airbase.ts"},["4402"] = {line = 25, file = "wr-airbase.ts"},["4410"] = {line = 29, file = "wr-airbase.ts"},["4418"] = {line = 33, file = "wr-airbase.ts"},["4426"] = {line = 37, file = "wr-airbase.ts"},["4427"] = {line = 41, file = "wr-airbase.ts"},["4428"] = {line = 43, file = "wr-airbase.ts"},["4429"] = {line = 43, file = "wr-airbase.ts"},["4430"] = {line = 43, file = "wr-airbase.ts"},["4431"] = {line = 44, file = "wr-airbase.ts"},["4432"] = {line = 45, file = "wr-airbase.ts"},["4433"] = {line = 50, file = "wr-airbase.ts"},["4434"] = {line = 50, file = "wr-airbase.ts"},["4435"] = {line = 43, file = "wr-airbase.ts"},["4436"] = {line = 43, file = "wr-airbase.ts"},["4437"] = {line = 53, file = "wr-airbase.ts"},["4452"] = {line = 1, file = "wr-ground-group.ts"},["4453"] = {line = 1, file = "wr-ground-group.ts"},["4454"] = {line = 4, file = "wr-ground-group.ts"},["4455"] = {line = 4, file = "wr-ground-group.ts"},["4456"] = {line = 6, file = "wr-ground-group.ts"},["4457"] = {line = 6, file = "wr-ground-group.ts"},["4458"] = {line = 8, file = "wr-ground-group.ts"},["4459"] = {line = 8, file = "wr-ground-group.ts"},["4460"] = {line = 8, file = "wr-ground-group.ts"},["4461"] = {line = 8, file = "wr-ground-group.ts"},["4462"] = {line = 11, file = "wr-ground-group.ts"},["4463"] = {line = 8, file = "wr-ground-group.ts"},["4464"] = {line = 11, file = "wr-ground-group.ts"},["4465"] = {line = 27, file = "wr-ground-group.ts"},["4466"] = {line = 28, file = "wr-ground-group.ts"},["4467"] = {line = 29, file = "wr-ground-group.ts"},["4468"] = {line = 30, file = "wr-ground-group.ts"},["4469"] = {line = 31, file = "wr-ground-group.ts"},["4470"] = {line = 29, file = "wr-ground-group.ts"},["4471"] = {line = 27, file = "wr-ground-group.ts"},["4472"] = {line = 37, file = "wr-ground-group.ts"},["4473"] = {line = 38, file = "wr-ground-group.ts"},["4474"] = {line = 40, file = "wr-ground-group.ts"},["4475"] = {line = 41, file = "wr-ground-group.ts"},["4476"] = {line = 42, file = "wr-ground-group.ts"},["4477"] = {line = 44, file = "wr-ground-group.ts"},["4478"] = {line = 44, file = "wr-ground-group.ts"},["4480"] = {line = 45, file = "wr-ground-group.ts"},["4481"] = {line = 46, file = "wr-ground-group.ts"},["4482"] = {line = 47, file = "wr-ground-group.ts"},["4483"] = {line = 48, file = "wr-ground-group.ts"},["4484"] = {line = 49, file = "wr-ground-group.ts"},["4485"] = {line = 50, file = "wr-ground-group.ts"},["4486"] = {line = 51, file = "wr-ground-group.ts"},["4487"] = {line = 52, file = "wr-ground-group.ts"},["4488"] = {line = 53, file = "wr-ground-group.ts"},["4489"] = {line = 57, file = "wr-ground-group.ts"},["4490"] = {line = 44, file = "wr-ground-group.ts"},["4491"] = {line = 63, file = "wr-ground-group.ts"},["4492"] = {line = 44, file = "wr-ground-group.ts"},["4493"] = {line = 44, file = "wr-ground-group.ts"},["4494"] = {line = 40, file = "wr-ground-group.ts"},["4495"] = {line = 37, file = "wr-ground-group.ts"},["4496"] = {line = 9, file = "wr-ground-group.ts"},["4507"] = {line = 2, file = "wr-helicopter-group.ts"},["4508"] = {line = 2, file = "wr-helicopter-group.ts"},["4509"] = {line = 5, file = "wr-helicopter-group.ts"},["4510"] = {line = 5, file = "wr-helicopter-group.ts"},["4511"] = {line = 7, file = "wr-helicopter-group.ts"},["4512"] = {line = 7, file = "wr-helicopter-group.ts"},["4513"] = {line = 7, file = "wr-helicopter-group.ts"},["4514"] = {line = 7, file = "wr-helicopter-group.ts"},["4515"] = {line = 8, file = "wr-helicopter-group.ts"},["4516"] = {line = 7, file = "wr-helicopter-group.ts"},["4517"] = {line = 8, file = "wr-helicopter-group.ts"},["4518"] = {line = 12, file = "wr-helicopter-group.ts"},["4519"] = {line = 13, file = "wr-helicopter-group.ts"},["4520"] = {line = 14, file = "wr-helicopter-group.ts"},["4521"] = {line = 15, file = "wr-helicopter-group.ts"},["4522"] = {line = 16, file = "wr-helicopter-group.ts"},["4523"] = {line = 18, file = "wr-helicopter-group.ts"},["4524"] = {line = 18, file = "wr-helicopter-group.ts"},["4526"] = {line = 19, file = "wr-helicopter-group.ts"},["4527"] = {line = 20, file = "wr-helicopter-group.ts"},["4528"] = {line = 21, file = "wr-helicopter-group.ts"},["4529"] = {line = 22, file = "wr-helicopter-group.ts"},["4530"] = {line = 23, file = "wr-helicopter-group.ts"},["4531"] = {line = 24, file = "wr-helicopter-group.ts"},["4532"] = {line = 25, file = "wr-helicopter-group.ts"},["4533"] = {line = 26, file = "wr-helicopter-group.ts"},["4534"] = {line = 27, file = "wr-helicopter-group.ts"},["4535"] = {line = 28, file = "wr-helicopter-group.ts"},["4536"] = {line = 18, file = "wr-helicopter-group.ts"},["4537"] = {line = 34, file = "wr-helicopter-group.ts"},["4538"] = {line = 18, file = "wr-helicopter-group.ts"},["4539"] = {line = 18, file = "wr-helicopter-group.ts"},["4540"] = {line = 14, file = "wr-helicopter-group.ts"},["4541"] = {line = 12, file = "wr-helicopter-group.ts"},["4553"] = {line = 1, file = "wr-coalition.ts"},["4554"] = {line = 1, file = "wr-coalition.ts"},["4555"] = {line = 2, file = "wr-coalition.ts"},["4556"] = {line = 2, file = "wr-coalition.ts"},["4557"] = {line = 3, file = "wr-coalition.ts"},["4558"] = {line = 3, file = "wr-coalition.ts"},["4559"] = {line = 5, file = "wr-coalition.ts"},["4560"] = {line = 5, file = "wr-coalition.ts"},["4561"] = {line = 7, file = "wr-coalition.ts"},["4562"] = {line = 7, file = "wr-coalition.ts"},["4563"] = {line = 7, file = "wr-coalition.ts"},["4564"] = {line = 8, file = "wr-coalition.ts"},["4565"] = {line = 8, file = "wr-coalition.ts"},["4566"] = {line = 8, file = "wr-coalition.ts"},["4571"] = {line = 11, file = "wr-coalition.ts"},["4572"] = {line = 11, file = "wr-coalition.ts"},["4573"] = {line = 13, file = "wr-coalition.ts"},["4574"] = {line = 11, file = "wr-coalition.ts"},["4582"] = {line = 17, file = "wr-coalition.ts"},["4583"] = {line = 18, file = "wr-coalition.ts"},["4584"] = {line = 18, file = "wr-coalition.ts"},["4585"] = {line = 18, file = "wr-coalition.ts"},["4586"] = {line = 19, file = "wr-coalition.ts"},["4587"] = {line = 20, file = "wr-coalition.ts"},["4589"] = {line = 22, file = "wr-coalition.ts"},["4590"] = {line = 23, file = "wr-coalition.ts"},["4592"] = {line = 25, file = "wr-coalition.ts"},["4593"] = {line = 26, file = "wr-coalition.ts"},["4595"] = {line = 18, file = "wr-coalition.ts"},["4596"] = {line = 18, file = "wr-coalition.ts"},["4597"] = {line = 29, file = "wr-coalition.ts"},["4601"] = {line = 33, file = "wr-coalition.ts"},["4602"] = {line = 34, file = "wr-coalition.ts"},["4603"] = {line = 35, file = "wr-coalition.ts"},["4618"] = {line = 1, file = "group.service.ts"},["4619"] = {line = 1, file = "group.service.ts"},["4620"] = {line = 6, file = "group.service.ts"},["4621"] = {line = 6, file = "group.service.ts"},["4622"] = {line = 7, file = "group.service.ts"},["4623"] = {line = 8, file = "group.service.ts"},["4624"] = {line = 9, file = "group.service.ts"},["4625"] = {line = 10, file = "group.service.ts"},["4626"] = {line = 12, file = "group.service.ts"},["4627"] = {line = 12, file = "group.service.ts"},["4628"] = {line = 14, file = "group.service.ts"},["4629"] = {line = 14, file = "group.service.ts"},["4630"] = {line = 15, file = "group.service.ts"},["4631"] = {line = 15, file = "group.service.ts"},["4632"] = {line = 17, file = "group.service.ts"},["4633"] = {line = 17, file = "group.service.ts"},["4634"] = {line = 17, file = "group.service.ts"},["4635"] = {line = 21, file = "group.service.ts"},["4636"] = {line = 21, file = "group.service.ts"},["4637"] = {line = 21, file = "group.service.ts"},["4639"] = {line = 21, file = "group.service.ts"},["4640"] = {line = 21, file = "group.service.ts"},["4641"] = {line = 27, file = "group.service.ts"},["4642"] = {line = 28, file = "group.service.ts"},["4643"] = {line = 28, file = "group.service.ts"},["4644"] = {line = 27, file = "group.service.ts"},["4645"] = {line = 34, file = "group.service.ts"},["4646"] = {line = 36, file = "group.service.ts"},["4649"] = {line = 37, file = "group.service.ts"},["4653"] = {line = 38, file = "group.service.ts"},["4655"] = {line = 35, file = "group.service.ts"},["4656"] = {line = 35, file = "group.service.ts"},["4657"] = {line = 39, file = "group.service.ts"},["4658"] = {line = 35, file = "group.service.ts"},["4659"] = {line = 34, file = "group.service.ts"},["4660"] = {line = 46, file = "group.service.ts"},["4661"] = {line = 47, file = "group.service.ts"},["4662"] = {line = 46, file = "group.service.ts"},["4663"] = {line = 56, file = "group.service.ts"},["4664"] = {line = 60, file = "group.service.ts"},["4665"] = {line = 61, file = "group.service.ts"},["4666"] = {line = 62, file = "group.service.ts"},["4667"] = {line = 63, file = "group.service.ts"},["4668"] = {line = 64, file = "group.service.ts"},["4670"] = {line = 67, file = "group.service.ts"},["4671"] = {line = 68, file = "group.service.ts"},["4672"] = {line = 69, file = "group.service.ts"},["4673"] = {line = 70, file = "group.service.ts"},["4675"] = {line = 74, file = "group.service.ts"},["4677"] = {line = 77, file = "group.service.ts"},["4678"] = {line = 78, file = "group.service.ts"},["4680"] = {line = 81, file = "group.service.ts"},["4681"] = {line = 82, file = "group.service.ts"},["4683"] = {line = 85, file = "group.service.ts"},["4684"] = {line = 87, file = "group.service.ts"},["4685"] = {line = 56, file = "group.service.ts"},["4686"] = {line = 90, file = "group.service.ts"},["4687"] = {line = 91, file = "group.service.ts"},["4688"] = {line = 93, file = "group.service.ts"},["4691"] = {line = 94, file = "group.service.ts"},["4695"] = {line = 95, file = "group.service.ts"},["4697"] = {line = 92, file = "group.service.ts"},["4698"] = {line = 92, file = "group.service.ts"},["4699"] = {line = 96, file = "group.service.ts"},["4700"] = {line = 92, file = "group.service.ts"},["4701"] = {line = 90, file = "group.service.ts"},["4702"] = {line = 19, file = "group.service.ts"},["4703"] = {line = 100, file = "group.service.ts"},["4713"] = {line = 1, file = "group.ts"},["4714"] = {line = 1, file = "group.ts"},["4715"] = {line = 2, file = "group.ts"},["4716"] = {line = 2, file = "group.ts"},["4717"] = {line = 4, file = "group.ts"},["4718"] = {line = 5, file = "group.ts"},["4719"] = {line = 5, file = "group.ts"},["4720"] = {line = 5, file = "group.ts"},["4721"] = {line = 12, file = "group.ts"},["4722"] = {line = 12, file = "group.ts"},["4723"] = {line = 12, file = "group.ts"},["4724"] = {line = 13, file = "group.ts"},["4725"] = {line = 13, file = "group.ts"},["4726"] = {line = 14, file = "group.ts"},["4727"] = {line = 14, file = "group.ts"},["4728"] = {line = 16, file = "group.ts"},["4729"] = {line = 18, file = "group.ts"},["4730"] = {line = 18, file = "group.ts"},["4731"] = {line = 19, file = "group.ts"},["4732"] = {line = 20, file = "group.ts"},["4733"] = {line = 21, file = "group.ts"},["4734"] = {line = 22, file = "group.ts"},["4735"] = {line = 25, file = "group.ts"},["4736"] = {line = 20, file = "group.ts"},["4737"] = {line = 30, file = "group.ts"},["4738"] = {line = 31, file = "group.ts"},["4739"] = {line = 32, file = "group.ts"},["4740"] = {line = 33, file = "group.ts"},["4741"] = {line = 34, file = "group.ts"},["4742"] = {line = 35, file = "group.ts"},["4744"] = {line = 37, file = "group.ts"},["4746"] = {line = 30, file = "group.ts"},["4747"] = {line = 18, file = "group.ts"},["4748"] = {line = 44, file = "group.ts"},["4749"] = {line = 44, file = "group.ts"},["4750"] = {line = 45, file = "group.ts"},["4751"] = {line = 46, file = "group.ts"},["4752"] = {line = 47, file = "group.ts"},["4753"] = {line = 48, file = "group.ts"},["4754"] = {line = 51, file = "group.ts"},["4755"] = {line = 46, file = "group.ts"},["4756"] = {line = 59, file = "group.ts"},["4757"] = {line = 60, file = "group.ts"},["4758"] = {line = 61, file = "group.ts"},["4759"] = {line = 62, file = "group.ts"},["4760"] = {line = 63, file = "group.ts"},["4761"] = {line = 64, file = "group.ts"},["4763"] = {line = 66, file = "group.ts"},["4765"] = {line = 59, file = "group.ts"},["4766"] = {line = 44, file = "group.ts"},["4767"] = {line = 73, file = "group.ts"},["4768"] = {line = 73, file = "group.ts"},["4769"] = {line = 74, file = "group.ts"},["4770"] = {line = 75, file = "group.ts"},["4771"] = {line = 76, file = "group.ts"},["4772"] = {line = 77, file = "group.ts"},["4773"] = {line = 80, file = "group.ts"},["4774"] = {line = 81, file = "group.ts"},["4775"] = {line = 75, file = "group.ts"},["4776"] = {line = 85, file = "group.ts"},["4777"] = {line = 86, file = "group.ts"},["4778"] = {line = 87, file = "group.ts"},["4779"] = {line = 88, file = "group.ts"},["4780"] = {line = 89, file = "group.ts"},["4781"] = {line = 90, file = "group.ts"},["4782"] = {line = 91, file = "group.ts"},["4784"] = {line = 93, file = "group.ts"},["4786"] = {line = 85, file = "group.ts"},["4787"] = {line = 73, file = "group.ts"},["4788"] = {line = 98, file = "group.ts"},["4789"] = {line = 98, file = "group.ts"},["4790"] = {line = 99, file = "group.ts"},["4791"] = {line = 100, file = "group.ts"},["4792"] = {line = 101, file = "group.ts"},["4793"] = {line = 102, file = "group.ts"},["4794"] = {line = 105, file = "group.ts"},["4795"] = {line = 106, file = "group.ts"},["4796"] = {line = 100, file = "group.ts"},["4797"] = {line = 110, file = "group.ts"},["4798"] = {line = 111, file = "group.ts"},["4799"] = {line = 112, file = "group.ts"},["4800"] = {line = 113, file = "group.ts"},["4801"] = {line = 113, file = "group.ts"},["4802"] = {line = 114, file = "group.ts"},["4803"] = {line = 115, file = "group.ts"},["4804"] = {line = 116, file = "group.ts"},["4805"] = {line = 117, file = "group.ts"},["4806"] = {line = 118, file = "group.ts"},["4807"] = {line = 119, file = "group.ts"},["4808"] = {line = 120, file = "group.ts"},["4810"] = {line = 122, file = "group.ts"},["4811"] = {line = 123, file = "group.ts"},["4813"] = {line = 110, file = "group.ts"},["4814"] = {line = 98, file = "group.ts"},["4827"] = {line = 1, file = "health.ts"},["4828"] = {line = 1, file = "health.ts"},["4829"] = {line = 2, file = "health.ts"},["4830"] = {line = 2, file = "health.ts"},["4831"] = {line = 4, file = "health.ts"},["4832"] = {line = 4, file = "health.ts"},["4833"] = {line = 6, file = "health.ts"},["4834"] = {line = 6, file = "health.ts"},["4835"] = {line = 7, file = "health.ts"},["4836"] = {line = 8, file = "health.ts"},["4837"] = {line = 9, file = "health.ts"},["4838"] = {line = 10, file = "health.ts"},["4839"] = {line = 8, file = "health.ts"},["4840"] = {line = 14, file = "health.ts"},["4841"] = {line = 15, file = "health.ts"},["4842"] = {line = 14, file = "health.ts"},["4843"] = {line = 6, file = "health.ts"},["4868"] = {line = 1, file = "time.dto.ts"},["4869"] = {line = 2, file = "time.dto.ts"},["4870"] = {line = 2, file = "time.dto.ts"},["4871"] = {line = 3, file = "time.dto.ts"},["4872"] = {line = 3, file = "time.dto.ts"},["4873"] = {line = 4, file = "time.dto.ts"},["4874"] = {line = 4, file = "time.dto.ts"},["4875"] = {line = 5, file = "time.dto.ts"},["4876"] = {line = 5, file = "time.dto.ts"},["4877"] = {line = 6, file = "time.dto.ts"},["4878"] = {line = 6, file = "time.dto.ts"},["4879"] = {line = 7, file = "time.dto.ts"},["4880"] = {line = 7, file = "time.dto.ts"},["4881"] = {line = 8, file = "time.dto.ts"},["4882"] = {line = 8, file = "time.dto.ts"},["4883"] = {line = 9, file = "time.dto.ts"},["4884"] = {line = 9, file = "time.dto.ts"},["4885"] = {line = 10, file = "time.dto.ts"},["4886"] = {line = 10, file = "time.dto.ts"},["4887"] = {line = 11, file = "time.dto.ts"},["4888"] = {line = 11, file = "time.dto.ts"},["4889"] = {line = 12, file = "time.dto.ts"},["4890"] = {line = 12, file = "time.dto.ts"},["4891"] = {line = 13, file = "time.dto.ts"},["4892"] = {line = 13, file = "time.dto.ts"},["4911"] = {line = 4, file = "airbase.service.ts"},["4912"] = {line = 5, file = "airbase.service.ts"},["4913"] = {line = 6, file = "airbase.service.ts"},["4914"] = {line = 7, file = "airbase.service.ts"},["4915"] = {line = 9, file = "airbase.service.ts"},["4916"] = {line = 9, file = "airbase.service.ts"},["4917"] = {line = 11, file = "airbase.service.ts"},["4918"] = {line = 11, file = "airbase.service.ts"},["4919"] = {line = 11, file = "airbase.service.ts"},["4921"] = {line = 11, file = "airbase.service.ts"},["4922"] = {line = 12, file = "airbase.service.ts"},["4923"] = {line = 14, file = "airbase.service.ts"},["4926"] = {line = 15, file = "airbase.service.ts"},["4930"] = {line = 16, file = "airbase.service.ts"},["4932"] = {line = 13, file = "airbase.service.ts"},["4933"] = {line = 13, file = "airbase.service.ts"},["4934"] = {line = 18, file = "airbase.service.ts"},["4935"] = {line = 19, file = "airbase.service.ts"},["4936"] = {line = 20, file = "airbase.service.ts"},["4937"] = {line = 21, file = "airbase.service.ts"},["4938"] = {line = 22, file = "airbase.service.ts"},["4939"] = {line = 23, file = "airbase.service.ts"},["4940"] = {line = 24, file = "airbase.service.ts"},["4941"] = {line = 18, file = "airbase.service.ts"},["4942"] = {line = 13, file = "airbase.service.ts"},["4943"] = {line = 12, file = "airbase.service.ts"},["4944"] = {line = 30, file = "airbase.service.ts"},["4952"] = {line = 23, file = "date.ts"},["4953"] = {line = 24, file = "date.ts"},["4954"] = {line = 23, file = "date.ts"},["4955"] = {line = 1, file = "date.ts"},["4956"] = {line = 6, file = "date.ts"},["4957"] = {line = 7, file = "date.ts"},["4958"] = {line = 8, file = "date.ts"},["4959"] = {line = 9, file = "date.ts"},["4960"] = {line = 10, file = "date.ts"},["4961"] = {line = 11, file = "date.ts"},["4962"] = {line = 12, file = "date.ts"},["4963"] = {line = 13, file = "date.ts"},["4964"] = {line = 14, file = "date.ts"},["4965"] = {line = 15, file = "date.ts"},["4966"] = {line = 16, file = "date.ts"},["4967"] = {line = 17, file = "date.ts"},["4968"] = {line = 18, file = "date.ts"},["4969"] = {line = 6, file = "date.ts"},["4970"] = {line = 20, file = "date.ts"},["4971"] = {line = 1, file = "date.ts"},["4972"] = {line = 27, file = "date.ts"},["4973"] = {line = 28, file = "date.ts"},["4974"] = {line = 27, file = "date.ts"},["4975"] = {line = 40, file = "date.ts"},["4976"] = {line = 43, file = "date.ts"},["4977"] = {line = 42, file = "date.ts"},["4978"] = {line = 41, file = "date.ts"},["4979"] = {line = 41, file = "date.ts"},["4980"] = {line = 42, file = "date.ts"},["4981"] = {line = 43, file = "date.ts"},["4982"] = {line = 46, file = "date.ts"},["4983"] = {line = 49, file = "date.ts"},["4984"] = {line = 50, file = "date.ts"},["4985"] = {line = 51, file = "date.ts"},["4986"] = {line = 54, file = "date.ts"},["4987"] = {line = 55, file = "date.ts"},["4989"] = {line = 58, file = "date.ts"},["4990"] = {line = 58, file = "date.ts"},["4991"] = {line = 59, file = "date.ts"},["4992"] = {line = 60, file = "date.ts"},["4993"] = {line = 61, file = "date.ts"},["4994"] = {line = 62, file = "date.ts"},["4995"] = {line = 63, file = "date.ts"},["4997"] = {line = 65, file = "date.ts"},["5000"] = {line = 68, file = "date.ts"},["5002"] = {line = 58, file = "date.ts"},["5005"] = {line = 73, file = "date.ts"},["5006"] = {line = 74, file = "date.ts"},["5007"] = {line = 75, file = "date.ts"},["5008"] = {line = 76, file = "date.ts"},["5009"] = {line = 79, file = "date.ts"},["5010"] = {line = 40, file = "date.ts"},["5019"] = {line = 2, file = "time.service.ts"},["5020"] = {line = 2, file = "time.service.ts"},["5021"] = {line = 4, file = "time.service.ts"},["5022"] = {line = 4, file = "time.service.ts"},["5023"] = {line = 4, file = "time.service.ts"},["5025"] = {line = 4, file = "time.service.ts"},["5026"] = {line = 5, file = "time.service.ts"},["5027"] = {line = 6, file = "time.service.ts"},["5028"] = {line = 7, file = "time.service.ts"},["5029"] = {line = 12, file = "time.service.ts"},["5030"] = {line = 13, file = "time.service.ts"},["5031"] = {line = 6, file = "time.service.ts"},["5032"] = {line = 5, file = "time.service.ts"},["5033"] = {line = 17, file = "time.service.ts"},["5034"] = {line = 18, file = "time.service.ts"},["5035"] = {line = 18, file = "time.service.ts"},["5036"] = {line = 18, file = "time.service.ts"},["5037"] = {line = 18, file = "time.service.ts"},["5038"] = {line = 17, file = "time.service.ts"},["5039"] = {line = 22, file = "time.service.ts"},["5046"] = {line = 1, file = "state.ts"},["5047"] = {line = 1, file = "state.ts"},["5048"] = {line = 2, file = "state.ts"},["5049"] = {line = 2, file = "state.ts"},["5050"] = {line = 4, file = "state.ts"},["5051"] = {line = 4, file = "state.ts"},["5052"] = {line = 5, file = "state.ts"},["5053"] = {line = 5, file = "state.ts"},["5054"] = {line = 6, file = "state.ts"},["5055"] = {line = 6, file = "state.ts"},["5056"] = {line = 7, file = "state.ts"},["5057"] = {line = 7, file = "state.ts"},["5058"] = {line = 9, file = "state.ts"},["5059"] = {line = 9, file = "state.ts"},["5060"] = {line = 10, file = "state.ts"},["5061"] = {line = 11, file = "state.ts"},["5062"] = {line = 12, file = "state.ts"},["5063"] = {line = 13, file = "state.ts"},["5064"] = {line = 11, file = "state.ts"},["5065"] = {line = 20, file = "state.ts"},["5066"] = {line = 21, file = "state.ts"},["5067"] = {line = 22, file = "state.ts"},["5068"] = {line = 23, file = "state.ts"},["5069"] = {line = 24, file = "state.ts"},["5070"] = {line = 25, file = "state.ts"},["5071"] = {line = 26, file = "state.ts"},["5072"] = {line = 21, file = "state.ts"},["5073"] = {line = 20, file = "state.ts"},["5074"] = {line = 9, file = "state.ts"},["5081"] = {line = 1, file = "index.ts"},["5082"] = {line = 2, file = "index.ts"},["5083"] = {line = 3, file = "index.ts"},["5084"] = {line = 4, file = "index.ts"},["5085"] = {line = 5, file = "index.ts"},["5093"] = {line = 1, file = "index.ts"},["5094"] = {line = 1, file = "index.ts"},["5095"] = {line = 1, file = "index.ts"},["5096"] = {line = 3, file = "index.ts"},["5097"] = {line = 3, file = "index.ts"},["5098"] = {line = 4, file = "index.ts"},["5099"] = {line = 18, file = "index.ts"},["5100"] = {line = 19, file = "index.ts"},["5101"] = {line = 20, file = "index.ts"},["5102"] = {line = 21, file = "index.ts"},["5103"] = {line = 22, file = "index.ts"},["5104"] = {line = 23, file = "index.ts"},["5105"] = {line = 24, file = "index.ts"},["5106"] = {line = 25, file = "index.ts"},["5107"] = {line = 20, file = "index.ts"},["5108"] = {line = 28, file = "index.ts"},["5111"] = {line = 64, file = "index.ts"},["5114"] = {line = 49, file = "index.ts"},["5115"] = {line = 50, file = "index.ts"},["5116"] = {line = 54, file = "index.ts"},["5117"] = {line = 55, file = "index.ts"},["5118"] = {line = 56, file = "index.ts"},["5119"] = {line = 57, file = "index.ts"},["5120"] = {line = 58, file = "index.ts"},["5121"] = {line = 59, file = "index.ts"},["5123"] = {line = 61, file = "index.ts"},["5130"] = {line = 67, file = "index.ts"},["5131"] = {line = 68, file = "index.ts"},["5132"] = {line = 69, file = "index.ts"},["5134"] = {line = 72, file = "index.ts"},["5135"] = {line = 73, file = "index.ts"},["5136"] = {line = 75, file = "index.ts"},["5137"] = {line = 76, file = "index.ts"},["5138"] = {line = 77, file = "index.ts"},["5140"] = {line = 80, file = "index.ts"},["5141"] = {line = 81, file = "index.ts"},["5144"] = {line = 85, file = "index.ts"},["5147"] = {line = 83, file = "index.ts"},["5153"] = {line = 88, file = "index.ts"},["5154"] = {line = 81, file = "index.ts"},["5155"] = {line = 90, file = "index.ts"},["5156"] = {line = 91, file = "index.ts"},["5157"] = {line = 80, file = "index.ts"},["5158"] = {line = 94, file = "index.ts"},["5159"] = {line = 98, file = "index.ts"},["5185"] = {line = 1, file = "decode-uri-component.ts"},["5186"] = {line = 2, file = "decode-uri-component.ts"},["5187"] = {line = 3, file = "decode-uri-component.ts"},["5188"] = {line = 3, file = "decode-uri-component.ts"},["5189"] = {line = 3, file = "decode-uri-component.ts"},["5190"] = {line = 3, file = "decode-uri-component.ts"},["5191"] = {line = 4, file = "decode-uri-component.ts"},["5192"] = {line = 5, file = "decode-uri-component.ts"},["5194"] = {line = 5, file = "decode-uri-component.ts"},["5198"] = {line = 6, file = "decode-uri-component.ts"},["5199"] = {line = 3, file = "decode-uri-component.ts"},["5200"] = {line = 3, file = "decode-uri-component.ts"},["5201"] = {line = 8, file = "decode-uri-component.ts"},["5202"] = {line = 1, file = "decode-uri-component.ts"},["5210"] = {line = 5, file = "server.ts"},["5211"] = {line = 5, file = "server.ts"},["5212"] = {line = 5, file = "server.ts"},["5213"] = {line = 11, file = "server.ts"},["5214"] = {line = 12, file = "server.ts"},["5215"] = {line = 13, file = "server.ts"},["5216"] = {line = 14, file = "server.ts"},["5217"] = {line = 11, file = "server.ts"},["5218"] = {line = 16, file = "server.ts"},["5219"] = {line = 17, file = "server.ts"},["5220"] = {line = 16, file = "server.ts"},["5221"] = {line = 21, file = "server.ts"},["5222"] = {line = 21, file = "server.ts"},["5223"] = {line = 21, file = "server.ts"},["5224"] = {line = 28, file = "server.ts"},["5225"] = {line = 32, file = "server.ts"},["5226"] = {line = 33, file = "server.ts"},["5227"] = {line = 34, file = "server.ts"},["5228"] = {line = 27, file = "server.ts"},["5236"] = {line = 1, file = "oas31.ts"},["5244"] = {line = 2, file = "oas31.ts"},["5252"] = {line = 3, file = "oas31.ts"},["5253"] = {line = 3, file = "oas31.ts"},["5254"] = {line = 3, file = "oas31.ts"},["5255"] = {line = 3, file = "oas31.ts"},["5256"] = {line = 3, file = "oas31.ts"},["5264"] = {line = 1, file = "index.ts"},["5266"] = {line = 2, file = "index.ts"},["5267"] = {line = 2, file = "index.ts"},["5268"] = {line = 2, file = "index.ts"},["5269"] = {line = 2, file = "index.ts"},["5270"] = {line = 2, file = "index.ts"},["5280"] = {line = 1, file = "coalition.service.ts"},["5281"] = {line = 1, file = "coalition.service.ts"},["5282"] = {line = 1, file = "coalition.service.ts"},["5284"] = {line = 1, file = "coalition.service.ts"},["5285"] = {line = 3, file = "coalition.service.ts"}});
return require("src.index", ...)
