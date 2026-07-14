// Zero-dependency static file server for the previews/ Playwright fixtures.
// Serves the repo root so previews/*.html can reference ../media/* with the
// same relative paths they'd use opened directly via file://.
//
// Usage: node scripts/serve.mjs [port]   (default 4173, matches playwright.config.ts)

import { createReadStream, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[2]) || 4173;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  let reqPath = decodeURIComponent(url.pathname);
  if (reqPath === "/") reqPath = "/previews/skills.html";

  // Resolve against root and refuse anything that escapes it (blocks "..").
  const filePath = path.join(root, reqPath);
  if (!filePath.startsWith(root + path.sep) && filePath !== root) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    res.writeHead(404).end("Not found");
    return;
  }
  if (stat.isDirectory()) {
    res.writeHead(404).end("Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  createReadStream(filePath).pipe(res);
});

server.listen(port, () => {
  console.log(`› Preview server: http://127.0.0.1:${port}/`);
});
