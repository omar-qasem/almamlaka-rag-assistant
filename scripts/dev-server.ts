// Local server without the Netlify CLI: serves public/ with the production
// headers from netlify.toml and routes /api/* to the same handlers the Netlify
// Functions call.
//
//   npm run serve          real Groq + Jina (keys from .env), knowledge bases in .data/
//   npm run serve:mock     offline: Groq/Jina replaced by the mock used in the tests
//
// `netlify dev` works too and also emulates Blobs and rate limits; this script
// only exists so the app can be run and tested with nothing but Node.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";

const MOCK = process.argv.includes("--mock");
const PORT = Number(process.env.PORT || 8888);
const ROOT = resolve("public");

try {
  process.loadEnvFile(".env");
} catch {
  /* no .env file: rely on the shell environment */
}

if (MOCK) {
  const { startMockAI } = await import("../tests/mock-ai");
  const mock = await startMockAI();
  Object.assign(process.env, { GROQ_BASE_URL: mock.url, JINA_BASE_URL: mock.url, GROQ_API_KEY: "mock", JINA_API_KEY: "mock" });
  process.env.KV_DRIVER ||= "memory";
}
process.env.KV_DRIVER ||= "file";

const { handleIngest } = await import("../src/api/ingest");
const { handleChat } = await import("../src/api/chat");
const { handleHealth, handleKb } = await import("../src/api/kb");

// Same security headers as production, read from netlify.toml.
function headersFromToml(): Record<string, string> {
  const toml = readFileSyncSafe("netlify.toml");
  const block = toml.split("[[headers]]").find((b) => /for\s*=\s*"\/\*"/.test(b)) ?? "";
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/^\s*([A-Za-z-]+)\s*=\s*"(.*)"\s*$/gm)) if (m[1] !== "for") out[m[1]] = m[2];
  return out;
}
function readFileSyncSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
const SECURITY_HEADERS = headersFromToml();

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".pfb": "application/octet-stream",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

async function serveStatic(pathname: string, res: ServerResponse) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = resolve(join(ROOT, rel));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) return send(res, 403, "Forbidden");
  try {
    const s = await stat(file);
    if (!s.isFile()) return send(res, 404, "Not found");
    const body = await readFile(file);
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(body);
  } catch {
    send(res, 404, "Not found");
  }
}

function send(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function toRequest(req: IncomingMessage, url: URL): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    duplex: "half",
  } as RequestInit);
}

async function route(req: IncomingMessage, url: URL): Promise<Response> {
  const p = url.pathname;
  const method = req.method ?? "GET";
  if (p === "/api/ingest" && method === "POST") return handleIngest(toRequest(req, url));
  if (p === "/api/chat" && method === "POST") return handleChat(toRequest(req, url));
  if (p === "/api/health" && method === "GET") return handleHealth();
  const kb = p.match(/^\/api\/kb\/([^/]+)$/);
  if (kb && method === "GET") return handleKb(decodeURIComponent(kb[1]));
  return new Response(JSON.stringify({ ok: false, error: { code: "not_found", message: "Not found" } }), { status: 404, headers: { "content-type": "application/json" } });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (!url.pathname.startsWith("/api/")) return await serveStatic(url.pathname, res);
    const response = await route(req, url);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
    }
    res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, String((e as Error)?.message ?? e));
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Almamlaka assistant on http://localhost:${PORT}  (${MOCK ? "mock AI" : "Groq + Jina"}, KV: ${process.env.KV_DRIVER})`);
});
