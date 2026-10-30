// A real Chromium cross-origin adapter fixture, no request routing or mocks.
// The Linux fixture runner owns a pinned server with exact-origin CORS for PORT.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setImmediate } from "node:timers";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { aliasQuery, aliasRoundTripQuery, assertExact, assertFixtureVersion, assertHealthyControl, assertLateFramingEvidence, assertReaderProbes, exactQuery, fixtureUrl, healthyControlSql, lateErrorSql, nativeOptions, PINNED_IMAGE, prepareLateErrorFixture, readerProbeSql, recordProof, refusedSql, slowSql, unsafeAliasQueries, waitForProcess } from "./fixture-contract.mjs";

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
const rootRequests = { received: 0, finished: 0, method: "missing", aborted: 0, completeAtFinish: 0, closedBeforeFinish: 0, adapter: 0 };
const increment = (value) => Math.min(value + 1, 1000);
const mimeKind = (value) => value === null || value === undefined ? "missing" : value.split(";")[0].trim().toLowerCase() === "text/html" ? "html" : "other";
const networkErrors = new Set(["net::ERR_ABORTED", "net::ERR_CONNECTION_REFUSED", "net::ERR_CONNECTION_RESET", "net::ERR_EMPTY_RESPONSE", "net::ERR_FAILED", "net::ERR_INSUFFICIENT_RESOURCES", "net::ERR_NETWORK_CHANGED", "net::ERR_TIMED_OUT", "net::ERR_CONNECTION_CLOSED", "net::ERR_INVALID_HTTP_RESPONSE", "net::ERR_BLOCKED_BY_CLIENT", "net::ERR_BLOCKED_BY_RESPONSE", "net::ERR_UNSAFE_PORT", "net::ERR_ADDRESS_UNREACHABLE", "net::ERR_NAME_NOT_RESOLVED", "net::ERR_HTTP_RESPONSE_CODE_FAILURE"]);
const blockedReasons = new Set(["other", "csp", "mixed-content", "origin", "inspector", "integrity", "subresource-filter", "content-type", "coep-frame-resource-needs-coep-header", "coop-sandboxed-iframe-cannot-navigate-to-coop-page", "corp-not-same-origin", "corp-not-same-origin-after-defaulted-to-same-origin-by-coep", "corp-not-same-origin-after-defaulted-to-same-origin-by-dip", "corp-not-same-origin-after-defaulted-to-same-origin-by-coep-and-dip", "corp-not-same-site", "sri-message-signature-mismatch"]);
const navigationReasons = new Set(["anchorClick", "formSubmissionGet", "formSubmissionPost", "httpHeaderRefresh", "initialFrameNavigation", "metaTagRefresh", "other", "pageBlockInterstitial", "reload", "scriptInitiated"]);
const protocolKinds = new Set(["http/1.0", "http/1.1", "http/2", "http/3", "h2", "h3"]);
const enumKind = (value, allowed) => value === undefined || value === null ? "missing" : allowed.has(value) ? value : "other";
const statusCode = (value) => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
/** Initial document only: no query URLs, headers, bodies or raw Playwright
 * errors are retained. A Node GET discriminates owned HTTP readiness from
 * Chromium's navigation without replacing the genuine browser navigation. */
async function navigateInitialDocument(page, browser) {
  const facts = { stage: "node-probe", nodeStatus: null, nodeMime: "missing", nodeBytes: 0, nodeBodyMatches: false, browserRequests: 0, browserResponses: 0, browserStatus: null, browserMime: "missing", requestFailed: false, networkError: "none", pageCrashed: false, download: false, browserDisconnected: false, gotoSucceeded: false };
  const initialDocument = (request) => request.isNavigationRequest() && request.url() === `${origin}/`;
  const onRequest = (request) => { if (initialDocument(request)) facts.browserRequests = increment(facts.browserRequests); };
  const onResponse = (response) => { if (initialDocument(response.request())) { facts.browserResponses = increment(facts.browserResponses); facts.browserStatus = response.status(); facts.browserMime = mimeKind(response.headers()["content-type"]); } };
  const onRequestFailed = (request) => { if (initialDocument(request)) { facts.requestFailed = true; const error = request.failure()?.errorText; facts.networkError = error === undefined ? "missing" : networkErrors.has(error) ? error : "other"; } };
  const onCrash = () => { facts.pageCrashed = true; };
  const onDownload = () => { facts.download = true; };
  const onDisconnected = () => { facts.browserDisconnected = true; };
  page.on("request", onRequest); page.on("response", onResponse); page.on("requestfailed", onRequestFailed); page.on("crash", onCrash); page.on("download", onDownload); browser.on("disconnected", onDisconnected);
  const cdpResponse = { mainRequestSeen: false, method: "missing", extraInfoStatus: null, responseSeen: false, responseStatus: null, mime: "missing", protocol: "missing", loadingFinished: false, extraInfoOverflow: false };
  const cdpFailure = { failed: false, canceled: null, error: "none", blocked: "missing", corsPresent: false };
  const cdpPage = { started: false, navigated: false, ownedDocument: false, stopped: false, domContentLoaded: false, loaded: false, requestedNavigation: false, requestedReason: "missing", detached: false, detachReason: "missing" };
  const pendingStatuses = new Map(); const cdpListeners = [];
  let cdp; let rootFrameId; let mainRequestId; let observing = false;
  let navigationFailed = false; let cleanupFailed = false;
  const diagnostic = () => {
    // Each fixed-shape line fits the runner's unchanged512-byte redaction cap.
    for (const value of [
      { diagnostic: "clickhouse-initial-document", ...facts, serverRootRequests: rootRequests.received, serverRootFinished: rootRequests.finished },
      { diagnostic: "clickhouse-initial-cdp-response", ...cdpResponse },
      { diagnostic: "clickhouse-initial-cdp-failure", ...cdpFailure },
      { diagnostic: "clickhouse-initial-cdp-page", ...cdpPage },
      { diagnostic: "clickhouse-initial-http", ...rootRequests },
    ]) { const line = JSON.stringify(value); assert.ok(Buffer.byteLength(line) <= 512, "Initial document diagnostic exceeded its fixed line bound."); console.log(line); }
  };
  try {
    facts.stage = "cdp-setup";
    cdp = await page.context().newCDPSession(page);
    const tree = await cdp.send("Page.getFrameTree"); rootFrameId = tree.frameTree.frame.id;
    assert.ok(typeof rootFrameId === "string" && rootFrameId, "Initial document root frame identity is missing.");
    const listen = (event, callback) => { cdp.on(event, callback); cdpListeners.push([event, callback]); };
    listen("Network.requestWillBeSent", (event) => {
      if (!observing || event.type !== "Document" || event.frameId !== rootFrameId || event.request.url !== `${origin}/` || mainRequestId !== undefined) return;
      mainRequestId = event.requestId; cdpResponse.mainRequestSeen = true; cdpResponse.method = event.request.method === "GET" ? "GET" : "other";
      if (pendingStatuses.has(mainRequestId)) cdpResponse.extraInfoStatus = pendingStatuses.get(mainRequestId);
      pendingStatuses.clear();
    });
    listen("Network.responseReceivedExtraInfo", (event) => {
      if (!observing) return;
      const status = statusCode(event.statusCode);
      if (event.requestId === mainRequestId) cdpResponse.extraInfoStatus = status;
      else if (mainRequestId === undefined) {
        if (pendingStatuses.size < 4 || pendingStatuses.has(event.requestId)) pendingStatuses.set(event.requestId, status);
        else cdpResponse.extraInfoOverflow = true;
      }
    });
    listen("Network.responseReceived", (event) => {
      if (!observing || event.requestId !== mainRequestId) return;
      cdpResponse.responseSeen = true; cdpResponse.responseStatus = statusCode(event.response.status); cdpResponse.mime = mimeKind(event.response.mimeType); cdpResponse.protocol = enumKind(event.response.protocol, protocolKinds);
    });
    listen("Network.loadingFailed", (event) => {
      if (!observing || event.requestId !== mainRequestId) return;
      cdpFailure.failed = true; cdpFailure.canceled = typeof event.canceled === "boolean" ? event.canceled : null; cdpFailure.error = enumKind(event.errorText, networkErrors); cdpFailure.blocked = enumKind(event.blockedReason, blockedReasons); cdpFailure.corsPresent = event.corsErrorStatus !== undefined;
    });
    listen("Network.loadingFinished", (event) => { if (observing && event.requestId === mainRequestId) cdpResponse.loadingFinished = true; });
    listen("Page.frameStartedLoading", (event) => { if (observing && event.frameId === rootFrameId) cdpPage.started = true; });
    listen("Page.frameNavigated", (event) => { if (observing && event.frame.id === rootFrameId) { cdpPage.navigated = true; cdpPage.ownedDocument = event.frame.url === `${origin}/`; } });
    listen("Page.frameStoppedLoading", (event) => { if (observing && event.frameId === rootFrameId) cdpPage.stopped = true; });
    listen("Page.domContentEventFired", () => { if (observing && cdpPage.navigated) cdpPage.domContentLoaded = true; });
    listen("Page.loadEventFired", () => { if (observing && cdpPage.navigated) cdpPage.loaded = true; });
    listen("Page.frameRequestedNavigation", (event) => { if (observing && event.frameId === rootFrameId) { cdpPage.requestedNavigation = true; cdpPage.requestedReason = enumKind(event.reason, navigationReasons); } });
    listen("Page.frameDetached", (event) => { if (observing && event.frameId === rootFrameId) { cdpPage.detached = true; cdpPage.detachReason = enumKind(event.reason, new Set(["remove", "swap"])); } });
    await cdp.send("Network.enable"); await cdp.send("Page.enable");
    facts.stage = "node-probe";
    const response = await fetch(origin, { redirect: "error", signal: AbortSignal.timeout(2000) });
    facts.nodeStatus = response.status; facts.nodeMime = mimeKind(response.headers.get("content-type"));
    if (facts.nodeStatus !== 200 || facts.nodeMime !== "html") { await response.body?.cancel(); throw new Error("Owned initial document HTTP probe failed."); }
    const expected = Buffer.from(pageHtml); const reader = response.body?.getReader(); const chunks = [];
    assert.ok(reader, "Owned initial document body is missing.");
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        facts.nodeBytes = Math.min(facts.nodeBytes + next.value.byteLength, 65_536);
        if (facts.nodeBytes > expected.byteLength) { await reader.cancel(); throw new Error("Owned initial document exceeded its exact body bound."); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    facts.nodeBodyMatches = Buffer.concat(chunks).equals(expected);
    assert.ok(facts.nodeBodyMatches, "Owned initial document does not match the fixed HTML.");
    facts.stage = "browser-goto"; observing = true;
    await page.goto(origin);
    facts.gotoSucceeded = true; facts.stage = "complete"; diagnostic();
  } catch {
    navigationFailed = true;
    // One event-loop drain observes already queued failure/download events;
    // this is neither another navigation nor a raised timeout.
    await new Promise((resolve) => setImmediate(resolve));
    diagnostic();
  } finally {
    observing = false; pendingStatuses.clear();
    page.off("request", onRequest); page.off("response", onResponse); page.off("requestfailed", onRequestFailed); page.off("crash", onCrash); page.off("download", onDownload); browser.off("disconnected", onDisconnected);
    if (cdp !== undefined) {
      for (const [event, callback] of cdpListeners) cdp.off(event, callback);
      try { await cdp.detach(); } catch { cleanupFailed = true; }
    }
  }
  if (cleanupFailed) console.log(JSON.stringify({ diagnostic: "clickhouse-initial-cdp-cleanup", detached: false, navigationFailed }));
  // Report after cleanup, retaining navigation failure when both operations fail.
  if (navigationFailed) throw new Error("Real initial document navigation failed; inspect the bounded navigation diagnostic.");
  if (cleanupFailed) throw new Error("Initial document diagnostic session cleanup failed.");
}
function startServer(listenPort) {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      if (listenPort === port && request.url === "/adapter.js") rootRequests.adapter = increment(rootRequests.adapter);
      if (listenPort === port && request.url === "/") {
        rootRequests.received = increment(rootRequests.received); rootRequests.method = request.method === "GET" ? "GET" : "other";
        request.once("aborted", () => { rootRequests.aborted = increment(rootRequests.aborted); });
        response.once("finish", () => { rootRequests.finished = increment(rootRequests.finished); if (request.complete) rootRequests.completeAtFinish = increment(rootRequests.completeAtFinish); });
        response.once("close", () => { if (!response.writableFinished) rootRequests.closedBeforeFinish = increment(rootRequests.closedBeforeFinish); });
      }
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
  await navigateInitialDocument(page, browser);
  await page.waitForFunction(() => typeof window.NativeClickHouseDatabase === "function");
  const browserOptions = { ...nativeOptions(serverUrl), headers: undefined };
  const readerProbes = await page.evaluate(async ({ options, sql }) => {
    const probes = [];
    for (const explicit of [false, true]) {
      const database = new window.NativeClickHouseDatabase({ ...options, headers: () => ({ "X-ClickHouse-User": "fixture_reader", "X-ClickHouse-Key": "synthetic-reader" }), fetch: (value, init) => {
        const url = new URL(value); if (explicit) url.searchParams.set("max_block_size", "1"); return fetch(url, init);
      } });
      try { probes.push({ result: await database.queryOrdinal({ kind: "native", sql }) }); }
      catch (error) { probes.push({ errorCode: error.code }); }
    }
    return probes;
  }, { options: browserOptions, sql: readerProbeSql });
  const readerProof = assertReaderProbes(readerProbes[0], readerProbes[1]);
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
  const controls = await page.evaluate(async ({ options, sql, healthySql }) => {
    // Same bounded primitive facts as Node. CORS may hide these headers;
    // absence never proves identity encoding or zero output.
    const facts = (response, started) => {
      const finite = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000_000 ? value : null;
      const encodings = ["identity", "gzip", "br", "deflate", "zstd", "lz4", "snappy", "xz", "bzip2"];
      const encoding = response.headers.get("content-encoding");
      let summary = null; const text = response.headers.get("x-clickhouse-summary");
      if (text !== null && text.length <= 8192) {
        try { const value = JSON.parse(text); if (value !== null && typeof value === "object" && !Array.isArray(value)) summary = value; } catch { /* Never return the raw header. */ }
      }
      const count = (key) => { const value = summary?.[key]; return typeof value === "string" && /^(?:0|[1-9][0-9]{0,15})$/.test(value) ? finite(Number(value)) : finite(value); };
      return { status: Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null,
        contentEncoding: encoding === null ? "missing-or-not-exposed" : encodings.includes(encoding) ? encoding : "other",
        resultRows: count("result_rows"), resultBytes: count("result_bytes"), elapsedNs: count("elapsed_ns"), headerElapsedMs: finite(Math.round(performance.now() - started)) };
    };
    const run = async (query) => {
      let observed;
      const database = new window.NativeClickHouseDatabase({ ...options, headers: () => ({ "X-ClickHouse-User": "fixture_reader", "X-ClickHouse-Key": "synthetic-reader" }), fetch: async (value, init) => {
        const url = new URL(value); url.searchParams.set("buffer_size", "1"); url.searchParams.set("wait_end_of_query", "0"); url.searchParams.set("max_block_size", "1");
        const started = performance.now(); const response = await fetch(url, init);
        const tag = response.headers.get("x-clickhouse-exception-tag");
        const exceptionCode = response.headers.get("x-clickhouse-exception-code");
        observed = { status: response.status, format: response.headers.get("x-clickhouse-format"), tagLength: tag?.length, tagValid: /^[a-z]{16}$/.test(tag ?? ""), exceptionCodePresent: response.headers.has("x-clickhouse-exception-code"),
          exceptionCode: exceptionCode !== null && /^(?:0|[1-9][0-9]{0,9})$/.test(exceptionCode) && Number(exceptionCode) <= 1_000_000_000 ? Number(exceptionCode) : null, ...facts(response, started) };
        return response;
      } });
      try { return { success: true, result: await database.queryOrdinal({ kind: "native", sql: query }), observed }; }
      catch (error) { return { success: false, observed, error: { code: error.code, framing: error.framing } }; }
    };
    const healthy = await run(healthySql); const late = await run(sql);
    return { healthy, late };
  }, { options: browserOptions, sql: lateErrorSql, healthySql: healthyControlSql });
  const healthyProof = assertHealthyControl({ result: controls.healthy.result, errorCode: controls.healthy.error?.code, observed: controls.healthy.observed });
  const late = controls.late;
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
  recordProof("chromium", { image: PINNED_IMAGE, version, browser: "Chromium", exactOrigin: origin, profileProof, readerProof, healthyProof, lateProof, wrongOriginRefused: "pass", noAuthAdminRefused: "pass", precisionAndDuplicates: "pass", duplicateMapKeys: "pass", nativeOptInRefused: "pass", aliasCapture: "pass", aliasRoundTripAndInjectionRefusal: "pass", writeSettingsAndScopeRefusal: "pass", serverCancellationObserved: { before: 1, after: 0 } });
} finally {
  await browser?.close();
  if (allowedServer !== undefined) await new Promise((resolve, reject) => allowedServer.close((error) => error ? reject(error) : resolve()));
  if (deniedServer !== undefined) await new Promise((resolve, reject) => deniedServer.close((error) => error ? reject(error) : resolve()));
}
