// Generate per-bridge Markdown API references from the checked-in OpenRPC
// goldens (bridge/crates/*/openrpc/*.openrpc.json) into docs/. Everything in
// the output derives from the JSON — no hand-written method docs — and the
// output is deterministic (stable ordering, no timestamps), so the pages are
// goldens too: test/docs/bridgeApiDocs.test.ts pins them to the JSON the same
// way the Rust tests pin the JSON to the live surface.
//
// Usage: npm run docs:bridge
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The bridges to document: OpenRPC source → generated page (repo-relative). */
export const BRIDGES = [
  {
    json: "bridge/crates/bridge-gui/openrpc/dcs_studio_gui.openrpc.json",
    out: "docs/bridge-api-gui.md",
  },
  {
    json: "bridge/crates/bridge-mission/openrpc/dcs_studio_mission.openrpc.json",
    out: "docs/bridge-api-mission.md",
  },
];

// Method groups, in page order. Anything that matches no prefix lands in
// "General" (ping, eval, dump_globals, emit_dlua, mission_boot, …).
const GROUPS = [
  { title: "General", prefix: null },
  { title: "Console (`console_*`)", prefix: "console_" },
  { title: "Unit database (`db_*`)", prefix: "db_" },
  { title: "Debugger (`debug_*`)", prefix: "debug_" },
  { title: "REPL & explorer (`repl_*`)", prefix: "repl_" },
  { title: "Discovery (`rpc.*`)", prefix: "rpc." },
];

/** GitHub-style anchor slug for a `### \`name\`` heading (backticks stripped). */
function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/ /g, "-");
}

/**
 * Escape Markdown-active characters outside code spans: a bare `<word>` reads
 * as raw HTML on GitHub (and gets swallowed), and paired `*` (e.g. "DCS.*,
 * net.*") would render as emphasis. Backtick code spans pass through intact.
 */
function escapeOutsideCodeSpans(text) {
  return String(text)
    .split("`")
    .map((part, i) => (i % 2 === 0 ? part.replace(/[<*]/g, "\\$&") : part))
    .join("`");
}

/**
 * Escape text for a Markdown table cell: pipes would split the cell and raw
 * newlines would end the row, on top of the usual prose escapes.
 */
function cell(text) {
  return escapeOutsideCodeSpans(String(text).replace(/\r?\n/g, " ").replace(/\|/g, "\\|"));
}

/** Escape prose (non-table) description text. */
function prose(text) {
  return escapeOutsideCodeSpans(text);
}

/** Human-readable type for an OpenRPC content-descriptor schema. */
function schemaType(schema) {
  if (schema && typeof schema.type === "string") return schema.type;
  return "any";
}

function renderParams(params) {
  if (!params || params.length === 0) return ["_No parameters._"];
  const lines = ["| Param | Type | Required | Description |", "| --- | --- | --- | --- |"];
  for (const p of params) {
    const required = p.required ? "yes" : "no";
    const description = p.description ? cell(p.description) : "—";
    lines.push(`| \`${p.name}\` | ${schemaType(p.schema)} | ${required} | ${description} |`);
  }
  return lines;
}

function renderResult(result) {
  if (!result) return "_No result (notification-style)._";
  const parts = [`\`${result.name}\` (${schemaType(result.schema)})`];
  if (result.description) parts.push(`— ${prose(result.description)}`);
  return `**Result:** ${parts.join(" ")}`;
}

function renderMethod(method) {
  const lines = [`### \`${method.name}\``, ""];
  if (method.summary) lines.push(prose(method.summary), "");
  if (method.description) lines.push(prose(method.description), "");
  lines.push(...renderParams(method.params), "");
  lines.push(renderResult(method.result), "");
  return lines;
}

/** Split the method list into GROUPS order, alphabetical within each group. */
function groupMethods(methods) {
  const sorted = [...methods].sort((a, b) => a.name.localeCompare(b.name, "en"));
  return GROUPS.map((group) => ({
    title: group.title,
    methods: sorted.filter((m) => {
      if (group.prefix) return m.name.startsWith(group.prefix);
      return GROUPS.every((g) => !g.prefix || !m.name.startsWith(g.prefix));
    }),
  })).filter((group) => group.methods.length > 0);
}

/**
 * Render one bridge's OpenRPC document as a Markdown reference page.
 * Pure: same document + sourcePath in, same string out — this is what the
 * golden test imports.
 */
export function renderBridgeDoc(doc, sourcePath) {
  const { info, servers = [], methods = [] } = doc;
  const groups = groupMethods(methods);
  const serverList = servers.map((s) => `\`${s.url}\` (${s.name})`).join(" · ");

  const lines = [
    `# ${info.title} — JSON-RPC method reference`,
    "",
    "<!-- GENERATED FILE — do not edit. Regenerate with `npm run docs:bridge`. -->",
    "",
    `> Generated from [\`${sourcePath}\`](../${sourcePath}) (bridge v${info.version},`,
    `> OpenRPC ${doc.openrpc}, env \`${info["x-dcs-env"]}\`). Do not edit by hand —`,
    "> regenerate with `npm run docs:bridge`. See [bridge-api.md](bridge-api.md) for",
    "> transports, ports, and how to fetch this document live via `rpc.discover`.",
    "",
    prose(info.description),
    "",
    `**Servers:** ${serverList}`,
    "",
    "## Methods",
    "",
  ];

  for (const group of groups) {
    const links = group.methods.map((m) => `[\`${m.name}\`](#${slug(m.name)})`).join(", ");
    lines.push(`- **${group.title}** — ${links}`);
  }
  lines.push("");

  for (const group of groups) {
    lines.push(`## ${group.title}`, "");
    for (const method of group.methods) {
      lines.push(...renderMethod(method));
    }
  }

  while (lines.at(-1) === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

/** Generate every page: repo-relative out path → rendered Markdown. */
export function generateAll(readJson) {
  const pages = new Map();
  for (const bridge of BRIDGES) {
    pages.set(bridge.out, renderBridgeDoc(readJson(bridge.json), bridge.json));
  }
  return pages;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const readJson = (rel) => JSON.parse(readFileSync(path.join(root, rel), "utf8"));
  for (const [out, content] of generateAll(readJson)) {
    writeFileSync(path.join(root, out), content);
    console.log(`wrote ${out}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
