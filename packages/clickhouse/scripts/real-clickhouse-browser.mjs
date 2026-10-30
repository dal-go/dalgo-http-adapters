// A real Chromium cross-origin adapter fixture, no request routing or mocks.
// The Linux fixture runner owns a pinned server with exact-origin CORS for PORT.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { aliasQuery, aliasRoundTripQuery, assertExact, assertFixtureVersion, assertLateFramingEvidence, exactQuery, fixtureUrl, lateErrorSql, nativeOptions, PINNED_IMAGE, prepareLateErrorFixture, recordProof, refusedSql, slowSql, unsafeAliasQueries, waitForProcess } from "./fixture-contract.mjs";

const serverUrl = fixtureUrl();
const version = await assertFixtureVersion(serverUrl);
const profileProof = await prepareLateErrorFixture(serverUrl);
const port = Number(process.env.CLICKHOUSE_BROWSER_PORT ?? "14389");
assert.ok(Number.isSafeInteger(port) && port > 1024 && port <= 65535);
const origin = `http://127.0.0.1:${port}`;
const preflight = await fetch(serverUrl, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-clickhouse-format,x-clickhouse-key,x-clickhouse-user" }, signal: AbortSignal.timeout(2000) });
assert.equal(preflight.headers.get("access-control-allow-origin"), origin, "exact-origin CORS must be configured; wildcard is insufficient");
const bundle = await build({ entryPoints: [new URL("../dist/index.js", import.meta.url).pathname], bundle: true, format: "esm", platform: "browser", write: false, logLevel: "silent" });
const javascript = bundle.outputFiles[0]?.text;
assert.ok(javascript);
const pageHtml = '<!doctype html><title>ClickHouse ordinal browser proof</title><h1>ClickHouse browser adapter</h1><output id="proof">Running real adapter checks</output><script type="module">import { NativeClickHouseDatabase } from "/adapter.js";window.NativeClickHouseDatabase=NativeClickHouseDatabase;</script>';
function startServer(listenPort) {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      if (request.url === "/adapter.js") { response.writeHead(200, { "content-type": "text/javascript" }); response.end(javascript); }
      else { response.writeHead(200, { "content-type": "text/html" }); response.end(pageHtml); }
    });
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => resolve(server));
  });
}
let allowedServer;
let deniedServer;
let browser;
try {
  allowedServer = await startServer(port);
  deniedServer = await startServer(0);
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => typeof window.NativeClickHouseDatabase === "function");
  const browserOptions = { ...nativeOptions(serverUrl), headers: undefined };
  const result = await page.evaluate(async ({ options, query }) => {
    const database = new window.NativeClickHouseDatabase({ ...options, headers: () => ({ "X-ClickHouse-User": "fixture_reader", "X-ClickHouse-Key": "synthetic-reader" }) });
    return await database.queryOrdinal(query);
  }, { options: browserOptions, query: exactQuery });
  assertExact(result);
  const mapAndConsent = await page.evaluate(async ({ options, query }) => {
    const headers = () => ({ "X-ClickHouse-User": "fixture_reader", "X-ClickHouse-Key": "synthetic-reader" });
    const database = new window.NativeClickHouseDatabase({ ...options, headers });
    const repeated = await database.queryOrdinal({ kind: "native", sql: "SELECT map('same', toUInt64(1), 'same', toUInt64(2)) AS m" });
    let refused = false;
    try { await new window.NativeClickHouseDatabase({ ...options, allowNativeSql: false, headers }).queryOrdinal(query); }
    catch (error) { refused = error.code === "permission"; }
    return { rows: repeated.rows, refused };
  }, { options: browserOptions, query: exactQuery });
  assert.deepEqual(mapAndConsent.rows, [[{ kind: "map", entries: [["same", { kind: "integer", value: "1" }], ["same", { kind: "integer", value: "2" }]] }]]);
  assert.equal(mapAndConsent.refused, true);
  const alias = await page.evaluate(async ({ options, query }) => new window.NativeClickHouseDatabase({ ...options, headers: () => ({ "X-ClickHouse-User": "fixture_reader", "X-ClickHouse-Key": "synthetic-reader" }) }).queryOrdinal(query), { options: browserOptions, query: aliasQuery });
  assert.deepEqual(alias, {
    columns: [{ name: "amount", nativeType: "UInt64" }],
    rows: [[{ kind: "integer", value: "7" }]],
  });
  const aliasLabels = await page.evaluate(async ({ options, query }) => {
    const result = await new window.NativeClickHouseDatabase({ ...options, headers: () => ({ "X-ClickHouse-User": "fixture_reader", "X-ClickHouse-Key": "synthetic-reader" }) }).queryOrdinal(query);
    return result.columns.map((column) => column.name);
  }, { options: browserOptions, query: aliasRoundTripQuery });
  assert.deepEqual(aliasLabels, ["a`b", "native id"]);
  const unsafeCalls = await page.evaluate(async ({ options, queries }) => {
    let calls = 0;
    const database = new window.NativeClickHouseDatabase({ ...options, allowNativeSql: false, headers: () => ({ "X-ClickHouse-User": "fixture_reader", "X-ClickHouse-Key": "synthetic-reader" }), fetch: (...args) => { calls += 1; return fetch(...args); } });
    for (const query of queries) {
      try { await database.queryOrdinal(query); return -1; } catch (error) { if (error.code !== "unsupported") return -1; }
    }
    return calls;
  }, { options: browserOptions, queries: unsafeAliasQueries });
  assert.equal(unsafeCalls, 0);
  const noAuthStatus = await page.evaluate(async (serverUrl) => {
    const response = await fetch(serverUrl, { method: "POST", credentials: "omit", headers: { "content-type": "text/plain; charset=utf-8", "x-clickhouse-format": "RowBinaryWithNamesAndTypes" }, body: "SELECT currentUser(), count() FROM system.processes" });
    return response.status;
  }, serverUrl);
  assert.ok([401, 403].includes(noAuthStatus), "browser must not reach default admin by omitting reader credentials");
  const late = await page.evaluate(async ({ options, sql }) => {
    let observed;
    const database = new window.NativeClickHouseDatabase({ ...options, headers: () => ({ "X-ClickHouse-User": "fixture_reader", "X-ClickHouse-Key": "synthetic-reader" }), fetch: async (value, init) => {
      const url = new URL(value); url.searchParams.set("buffer_size", "1"); url.searchParams.set("wait_end_of_query", "0");
      const response = await fetch(url, init);
      const tag = response.headers.get("x-clickhouse-exception-tag");
      observed = { status: response.status, format: response.headers.get("x-clickhouse-format"), tagLength: tag?.length, tagValid: /^[a-z]{16}$/.test(tag ?? "") };
      return response;
    } });
    try { await database.queryOrdinal({ kind: "native", sql }); return { success: true, observed }; }
    catch (error) { return { success: false, observed, error: { code: error.code, framing: error.framing } }; }
  }, { options: browserOptions, sql: lateErrorSql });
  assert.equal(late.success, false);
  const lateProof = assertLateFramingEvidence(late.error, late.observed);
  for (const sql of refusedSql) {
    const refused = await page.evaluate(async ({ options, sql }) => {
      try { await new window.NativeClickHouseDatabase({ ...options, headers: () => ({ "X-ClickHouse-User": "fixture_reader", "X-ClickHouse-Key": "synthetic-reader" }) }).queryOrdinal({ kind: "native", sql }); return false; }
      catch (error) { return error.name === "ClickHouseNativeError" && ["response", "framing"].includes(error.code); }
    }, { options: browserOptions, sql });
    assert.equal(refused, true);
  }
  await page.evaluate(({ options, sql }) => {
    window.cancelController = new AbortController();
    const database = new window.NativeClickHouseDatabase({ ...options, headers: () => ({ "X-ClickHouse-User": "fixture_reader", "X-ClickHouse-Key": "synthetic-reader" }), fetch: (url, init) => {
      if (init.body === sql) window.runningQueryId = new URL(url).searchParams.get("query_id");
      return fetch(url, init);
    } });
    window.cancelOutcome = database.queryOrdinal({ kind: "native", sql }, window.cancelController.signal).then(() => "unexpected success", (error) => error.reason);
  }, { options: browserOptions, sql: slowSql });
  await page.waitForFunction(() => typeof window.runningQueryId === "string");
  const id = await page.evaluate(() => window.runningQueryId);
  await waitForProcess(serverUrl, id, 1);
  assert.equal(await page.evaluate(async () => { window.cancelController.abort(); return await window.cancelOutcome; }), "caller");
  await waitForProcess(serverUrl, id, 0, 1000);
  const deniedAddress = deniedServer.address();
  assert.equal(typeof deniedAddress, "object");
  const denied = await browser.newPage();
  await denied.goto(`http://127.0.0.1:${deniedAddress.port}`);
  await denied.waitForFunction(() => typeof window.NativeClickHouseDatabase === "function");
  const deniedResult = await denied.evaluate(async ({ options, query }) => {
    try { await new window.NativeClickHouseDatabase({ ...options, headers: () => ({ "X-ClickHouse-User": "fixture_reader", "X-ClickHouse-Key": "synthetic-reader" }) }).queryOrdinal(query); return "unexpected success"; }
    catch (error) { return error.code; }
  }, { options: browserOptions, query: exactQuery });
  assert.equal(deniedResult, "transport");
  await page.evaluate((result) => { document.querySelector("#proof").textContent = JSON.stringify(result, null, 2); }, result);
  recordProof("chromium", { image: PINNED_IMAGE, version, browser: "Chromium", exactOrigin: origin, profileProof, lateProof, wrongOriginRefused: "pass", noAuthAdminRefused: "pass", precisionAndDuplicates: "pass", duplicateMapKeys: "pass", nativeOptInRefused: "pass", aliasCapture: "pass", aliasRoundTripAndInjectionRefusal: "pass", writeSettingsAndScopeRefusal: "pass", serverCancellationObserved: { before: 1, after: 0 } });
} finally {
  await browser?.close();
  if (allowedServer !== undefined) await new Promise((resolve, reject) => allowedServer.close((error) => error ? reject(error) : resolve()));
  if (deniedServer !== undefined) await new Promise((resolve, reject) => deniedServer.close((error) => error ? reject(error) : resolve()));
}
