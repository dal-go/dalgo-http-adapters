// Static server for the real-browser suite. It bundles the fixture page (which
// imports the real adapter and calls the real libSQL server) and never proxies
// or fakes a libSQL response. Run with Node 24 type stripping:
// node test/browser/server.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "..", ".browser");
const port = Number(process.env.PORT ?? "4328");

mkdirSync(out, { recursive: true });
await build({
  entryPoints: { page: join(here, "fixtures", "page.ts") },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outdir: out,
  sourcemap: true,
  logLevel: "warning",
});
writeFileSync(
  join(out, "index.html"),
  "<!doctype html><meta charset=utf-8><title>libsql-browser</title><script type=module src=/page.js></script>\n",
);

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".map": "application/json",
};

createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (path === "/health") {
    response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
    response.end("ok");
    return;
  }
  const file = join(out, path === "/" ? "index.html" : path);
  if (!file.startsWith(out)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = readFileSync(file);
    response.writeHead(200, {
      "content-type": types[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, () => {
  console.log(`libSQL browser fixture page on http://127.0.0.1:${String(port)}`);
});
