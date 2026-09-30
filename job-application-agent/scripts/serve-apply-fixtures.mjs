#!/usr/bin/env node
/**
 * Tiny static server for owned apply fixtures (local / CI).
 *
 *   node scripts/serve-apply-fixtures.mjs [--port 4173]
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../fixtures", import.meta.url)));
const portArg = process.argv.includes("--port")
  ? Number(process.argv[process.argv.indexOf("--port") + 1])
  : Number(process.env.FIXTURE_PORT || 4173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function safeJoin(root, requestPath) {
  const cleaned = decodeURIComponent(requestPath.split("?")[0]).replace(/^\/+/, "");
  const target = resolve(root, cleaned);
  if (target !== root && !target.startsWith(root + sep)) throw new Error("path escape");
  return target;
}

const server = createServer(async (req, res) => {
  try {
    let pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    if (pathname === "/") pathname = "/README.md";
    // Map /fixtures/... → package fixtures root (mirrors jobappagent.com paths).
    if (pathname.startsWith("/fixtures/")) pathname = pathname.slice("/fixtures".length) || "/";
    let filePath = safeJoin(ROOT, pathname);
    if (pathname.endsWith("/")) filePath = join(filePath, "index.html");
    else if (!extname(filePath)) {
      try {
        filePath = join(filePath, "index.html");
      } catch {
        /* fall through */
      }
    }
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": TYPES[extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found\n");
  }
});

server.listen(portArg, "127.0.0.1", () => {
  process.stdout.write(`Apply fixtures at http://127.0.0.1:${portArg}/fixtures/greenhouse/\n`);
  process.stdout.write(`                   http://127.0.0.1:${portArg}/fixtures/lever/\n`);
  process.stdout.write(`                   http://127.0.0.1:${portArg}/fixtures/ashby/\n`);
});
