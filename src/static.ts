import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

// Serves the built studio (web/dist) under /studio/. Unknown paths without a file extension get
// index.html so the app's own routes work on reload.
const ROOT = resolve(process.env.LINKEDBOT_WEB_DIST ?? "web/dist");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export function serveStudio(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (pathname === "/" || pathname === "/studio") {
    res.writeHead(302, { location: "/studio/" }).end();
    return true;
  }
  if (!pathname.startsWith("/studio/")) return false;
  const rel = normalize(decodeURIComponent(pathname.slice("/studio/".length))).replace(/^(\.\.(\/|\\|$))+/, "");
  let file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) return false;
  const isFile = existsSync(file) && statSync(file).isFile();
  if (!isFile) {
    if (extname(rel)) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return true;
    }
    file = join(ROOT, "index.html");
    if (!existsSync(file)) {
      res.writeHead(503, { "content-type": "text/plain" }).end("The studio has not been built (npm run build:web).");
      return true;
    }
  }
  // Built assets have content hashes in their names; index.html must always be fetched fresh.
  const immutable = rel.startsWith("assets/");
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
    ...(file.endsWith(".html") ? { "x-frame-options": "DENY", "referrer-policy": "same-origin" } : {}),
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
  return true;
}
