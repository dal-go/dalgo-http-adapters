// Real Chromium CORS smoke for NativeCouchDbDatabase.
//
// Run from a workspace package that has `playwright` and `esbuild` installed,
// for example:
//   cd packages/sqlite-wasm
//   COUCHDB_NATIVE_URL=... COUCHDB_NATIVE_BROWSER_ORIGIN=http://127.0.0.1:<port>/ \
//     node ../couchdb/scripts/browser-native-smoke.mjs
//
// It serves a page from the exact configured browser origin and uses the real
// browser `fetch` against a disposable CouchDB with that origin in its CORS
// allowlist. No vendor transport is mocked.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(join(process.cwd(), "package.json"));
const { chromium } = require("@playwright/test");
const { build } = require("esbuild");

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");
const url = process.env.COUCHDB_NATIVE_URL;
const origin = process.env.COUCHDB_NATIVE_BROWSER_ORIGIN;
const user = process.env.COUCHDB_NATIVE_USER ?? "reader";
const password = process.env.COUCHDB_NATIVE_PASSWORD ?? "readerpass";
const indexDdoc = process.env.COUCHDB_NATIVE_INDEX_DDOC ?? "_design/status-id-ddoc";
const indexName = process.env.COUCHDB_NATIVE_INDEX_NAME ?? "status-id-index";
if (!url || !origin) throw new Error("COUCHDB_NATIVE_URL and COUCHDB_NATIVE_BROWSER_ORIGIN are required");

const originUrl = new URL(origin);
if (originUrl.protocol !== "http:" || originUrl.hostname !== "127.0.0.1") {
  throw new Error("COUCHDB_NATIVE_BROWSER_ORIGIN must be an http://127.0.0.1 origin");
}

const scratch = mkdtempSync(join(tmpdir(), "dalgo-couchdb-browser-"));
const bundleFile = join(scratch, "bundle.js");
await build({
  entryPoints: [join(packageDirectory, "test", "browser-native-fixture.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: bundleFile,
  logLevel: "silent",
});

const bundle = readFileSync(bundleFile, "utf8");
const config = JSON.stringify({ url, user, password, indexDdoc, indexName }).replaceAll("<", "\\u003c");
const html = `<!doctype html>
<meta charset="utf-8">
<title>Native CouchDB browser proof</title>
<script type="module">
import { runNativeBrowserProof } from "./bundle.js";
const config = ${config};
window.proofResult = runNativeBrowserProof(config).then(
  (value) => ({ ok: true, value }),
  (error) => ({ ok: false, error: String(error), stack: error && error.stack ? String(error.stack) : "" }),
);
</script>`;

const server = createServer((request, response) => {
  if (request.url === "/bundle.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end(bundle);
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
});

let browser;
try {
  await new Promise((resolveReady, rejectReady) => {
    server.once("error", rejectReady);
    server.listen(Number(originUrl.port), originUrl.hostname, resolveReady);
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  await page.goto(originUrl.toString(), { waitUntil: "load" });
  await page.waitForFunction(() => window.proofResult !== undefined, undefined, { timeout: 30_000 });
  const result = await page.evaluate(() => window.proofResult);
  const unexpectedConsoleErrors = consoleErrors.filter((message) => !/^Failed to load resource: the server responded with a status of (?:401|403|404) /u.test(message));
  if (unexpectedConsoleErrors.length > 0) throw new Error(`browser console errors: ${unexpectedConsoleErrors.join("; ")}`);
  if (!result?.ok) throw new Error(`browser proof failed: ${String(result?.error)}\n${String(result?.stack)}`);
  if (result.value.origin !== originUrl.origin) throw new Error("browser origin does not match the configured CORS origin");
  const receipt = { synthetic: false, browser: "chromium", corsOrigin: originUrl.origin, ...result.value };
  const output = `${JSON.stringify(receipt, null, 2)}\n`;
  if (process.env.COUCHDB_NATIVE_BROWSER_RECEIPT) writeFileSync(process.env.COUCHDB_NATIVE_BROWSER_RECEIPT, output);
  process.stdout.write(output);
} finally {
  await browser?.close();
  await new Promise((resolveClose) => server.close(() => resolveClose(undefined)));
  rmSync(scratch, { recursive: true, force: true });
}
