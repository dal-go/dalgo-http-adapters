// Static server for the Playwright suite: bundles the fixtures with esbuild and
// serves them with the real Chinook file. It sets no COOP/COEP headers, like
// the production host, so the page is not cross-origin isolated.
//
// Run with Node 24 (TypeScript type stripping): node test/browser/server.ts
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "..", ".browser");
const port = Number(process.env.PORT ?? "4317");
const chinookPath = process.env.CHINOOK_SQLITE;
if (chinookPath === undefined || chinookPath === "") throw new Error("set CHINOOK_SQLITE to a local chinook.sqlite");

mkdirSync(join(out, "data"), { recursive: true });
await build({
  entryPoints: { page: join(here, "fixtures", "page.ts"), worker: join(here, "fixtures", "worker.ts") },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outdir: out,
  sourcemap: true,
  logLevel: "warning",
});
const require = createRequire(import.meta.url);
copyFileSync(join(dirname(require.resolve("@sqlite.org/sqlite-wasm")), "sqlite3.wasm"), join(out, "sqlite3.wasm"));
writeFileSync(join(out, "index.html"), "<!doctype html><meta charset=utf-8><title>demodb</title><script type=module src=/page.js></script>\n");

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const chinook = new Uint8Array(readFileSync(chinookPath));

// A second version of the dataset: the same file with one artist renamed.
const sqlite3 = await sqlite3InitModule();
const db = new sqlite3.oo1.DB(":memory:");
const pointer = sqlite3.wasm.allocFromTypedArray(chinook);
sqlite3.capi.sqlite3_deserialize(db, "main", pointer, chinook.length, chinook.length,
  sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE);
db.exec("UPDATE Artist SET Name = 'AC/DC (v2)' WHERE ArtistId = 1");
const v2 = sqlite3.capi.sqlite3_js_db_export(db);
db.close();

// The gzip-in-parts layout of the large datasets (adventureworks).
const gz = gzipSync(chinook);
const half = Math.ceil(gz.length / 2);
const parts = [gz.subarray(0, half), gz.subarray(half)];

writeFileSync(join(out, "data", "chinook.sqlite"), chinook);
writeFileSync(join(out, "data", "chinook-v2.sqlite"), v2);
parts.forEach((part, index) => { writeFileSync(join(out, "data", `chinook.sqlite.gz.part-${String(index + 1)}`), part); });

const pins = {
  chinook: { dataset: "chinook", url: "/data/chinook.sqlite", sha256: sha256(chinook), bytes: chinook.length },
  chinookV2: { dataset: "chinook", url: "/data/chinook-v2.sqlite", sha256: sha256(v2), bytes: v2.length },
  chinookParts: {
    dataset: "chinookgz", url: "/data/", sha256: sha256(chinook), bytes: chinook.length, compression: "gzip",
    parts: parts.map((part, index) => ({ url: `chinook.sqlite.gz.part-${String(index + 1)}`, sha256: sha256(part), bytes: part.length })),
  },
};
writeFileSync(join(out, "pins.json"), JSON.stringify(pins, null, 2));

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".map": "application/json",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const file = join(out, path === "/" ? "index.html" : path);
  if (!file.startsWith(out)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = readFileSync(file);
    response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`demodb test server on http://127.0.0.1:${String(port)} (chinook sha256 ${pins.chinook.sha256})`);
});
