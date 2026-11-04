// Optional standalone Chromium fixture. Called by the owned real-mongodb.ts
// service lifecycle; never starts another MongoDB or an application server.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire, isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { chromium, type Page } from "playwright";
import type { MongoReadExecutor } from "../src/types.js";
import type { createMongoHttpHandler } from "../src/http.js";

interface FixtureOptions {
  readonly executor: MongoReadExecutor;
  readonly invalidAuthExecutor: MongoReadExecutor;
  readonly createHandler: typeof createMongoHttpHandler;
  readonly expectedId: string;
  readonly expectedDocument: Readonly<Record<string, unknown>>;
  readonly armBlockedRead: () => Promise<number>;
  readonly waitForBlockedRead: (count: number) => Promise<void>;
}
interface Failure { readonly name: string; readonly code?: string; readonly reason?: string; readonly message: string; }
interface BasicResult {
  readonly document: Readonly<Record<string, unknown>>;
  readonly metadata: unknown;
  readonly ids: readonly string[];
  readonly finalCursor: unknown;
  readonly badAppAuth: Failure;
  readonly badProviderAuth: Failure;
  readonly overflow: Failure;
  readonly injectionStatus: number;
}
interface Sample { readonly stage: string; readonly pids: number; readonly pidsPeak: string | null; readonly memory: number; }

export interface PreparedMongoBrowser {
  readonly page: Page;
  readonly errors: readonly string[];
  readonly samples: readonly Sample[];
  sample(stage: string): Promise<void>;
  close(): Promise<void>;
}

/** Prepare the only browser/context/page before the caller starts mongod. */
export async function prepareMongoBrowser(): Promise<PreparedMongoBrowser> {
  const require = createRequire(import.meta.url);
  const playwrightManifest: unknown = JSON.parse(await readFile(require.resolve("playwright/package.json"), "utf8"));
  assert(playwrightManifest !== null && typeof playwrightManifest === "object" && "version" in playwrightManifest);
  assert.equal(playwrightManifest.version, "1.64.1");
  const samples: Sample[] = [];
  async function sample(stage: string): Promise<void> {
    let pidsPeak: string | null = null;
    try { pidsPeak = (await readFile("/sys/fs/cgroup/pids.peak", "utf8")).trim(); } catch { /* Kernel-dependent metric. */ }
    samples.push({ stage, pids: Number((await readFile("/sys/fs/cgroup/pids.current", "utf8")).trim()), pidsPeak, memory: Number((await readFile("/sys/fs/cgroup/memory.current", "utf8")).trim()) });
  }
  await sample("before-browser-before-mongod");
  const interval = setInterval(() => { void sample("running").catch(() => undefined); }, 100);
  interval.unref();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    // Same browser flags and acceptance assertions as the prior fixture. Only
    // startup order changes; the renderer is ready before MongoDB adds threads.
    browser = await chromium.launch({ timeout: 15_000, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--renderer-process-limit=1"] });
    const owned = browser;
    const context = await owned.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto("about:blank");
    const errors: string[] = [];
    page.on("pageerror", (error) => { errors.push(error.message); });
    await sample("blank-page-ready-before-mongod");
    let closed = false;
    return {
      page, errors, samples, sample,
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        try { await owned.close(); await sample("browser-closed"); }
        finally { clearInterval(interval); }
      },
    };
  } catch (error) {
    clearInterval(interval);
    try { await browser?.close(); } catch { /* Root always removes the owned container. */ }
    await sample("browser-preparation-failed");
    process.stderr.write(JSON.stringify({ mongoBrowserFailureResourceSamples: samples }) + "\n");
    throw error;
  }
}

export async function runMongoBrowserFixture(options: FixtureOptions, prepared: PreparedMongoBrowser): Promise<Readonly<Record<string, unknown>>> {
  const { page, errors, samples } = prepared;
  const sample = (stage: string): Promise<void> => prepared.sample(stage);
  assert(!page.isClosed(), "reuse the one prepared browser page");
  await sample("bridge-fixture-start-after-service");
  const token = `Bearer synthetic-${randomBytes(16).toString("hex")}`;
  // Only browser-safe public output is bundled. The Node executor is injected
  // into the real HTTP handler below, never imported into this browser entry.
  const contents = `
import { MongoDatabase, MongoHttpClient } from './dist/index.js';
import { collection, Key } from '@dalgo/core';
const headers = () => ({ authorization: ${JSON.stringify(token)} });
const transport = new MongoHttpClient({ endpoint: '/api/mongo', connectionId: 'owned', headers, timeoutMs: 10000 });
const db = new MongoDatabase(transport);
const products = collection('products');
function describe(error) { return { name: error.name, code: error.code, reason: error.reason, message: error.message }; }
async function refused(pending) { try { await pending; return { name: 'UNEXPECTED_SUCCESS', message: '' }; } catch (error) { return describe(error); } }
let caller, pending;
globalThis.mongoFixture = {
  async basic() {
    const document = (await db.get(new Key('products', ${JSON.stringify(options.expectedId)}))).data;
    const metadata = await transport.execute({ kind: 'discover' });
    const query = products.query().where('active', '==', true).limit(1);
    const first = await db.query(query.build());
    if (!first.nextCursor) throw new Error('missing actual continuation');
    const second = await db.query(products.query().where('active', '==', true).limit(1).startAfter(...first.nextCursor.values).build());
    const badAppAuth = await refused(new MongoHttpClient({ endpoint: '/api/mongo', connectionId: 'owned', headers: () => ({ authorization: 'Bearer invalid-app-user' }) }).execute({ kind: 'discover' }));
    const badProviderAuth = await refused(new MongoHttpClient({ endpoint: '/api/mongo', connectionId: 'invalid-provider', headers }).execute({ kind: 'find', collection: 'products', limit: 1 }));
    const overflow = await refused(transport.execute({ kind: 'find', collection: 'products', limit: 11 }));
    const injected = await fetch('/api/mongo', { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify({ connectionId: 'owned', request: { kind: 'discover' }, endpoint: 'mongodb://forbidden.invalid', credentials: 'forbidden' }) });
    return { document, metadata, ids: [first.records[0]?.key.id, second.records[0]?.key.id], finalCursor: second.nextCursor ?? null, badAppAuth, badProviderAuth, overflow, injectionStatus: injected.status };
  },
  startCaller() {
    caller = new AbortController();
    pending = refused(transport.execute({ kind: 'find', collection: 'products', limit: 1 }, caller.signal));
  },
  abortCaller() { caller.abort('synthetic-secret-reason'); },
  finishCaller() { return pending; },
  async deadline() {
    return refused(new MongoHttpClient({ endpoint: '/api/mongo-short', connectionId: 'owned', headers, timeoutMs: 10000 }).execute({ kind: 'find', collection: 'products', limit: 1 }));
  },
  async reopen() { return (await db.get(new Key('products', ${JSON.stringify(options.expectedId)}))).data; }
};
globalThis.mongoFixtureReady = true;
`;
  const compiled = await build({ stdin: { contents, resolveDir: fileURLToPath(new URL("..", import.meta.url)), sourcefile: "mongo-real-browser-fixture.js" }, platform: "browser", bundle: true, format: "esm", write: false, metafile: true });
  for (const [name, input] of Object.entries(compiled.metafile.inputs)) {
    assert.doesNotMatch(name, /(?:^|\/)node_modules\/(?:mongodb|bson|socks|kerberos|mongodb-client-encryption)(?:\/|$)|node-executor\.[jt]s$/u);
    for (const imported of input.imports) assert(!imported.path.startsWith("node:") && !isBuiltin(imported.path));
  }
  const bundle = compiled.outputFiles[0];
  assert(bundle !== undefined && compiled.outputFiles.length === 1);
  let origin = "";
  let disconnects = 0;
  let requestSignalAborts = 0;
  const active = new Set<AbortController>();
  const authorize = (request: Request, id: string): Promise<MongoReadExecutor | undefined> => Promise.resolve(
    request.headers.get("authorization") === token && request.headers.get("origin") === origin
      ? id === "owned" ? options.executor : id === "invalid-provider" ? options.invalidAuthExecutor : undefined
      : undefined,
  );
  const handler = options.createHandler({ authorize, timeoutMs: 10_000, maxRows: 10 });
  const shortHandler = options.createHandler({ authorize, timeoutMs: 500, maxRows: 10 });
  const server = createServer((incoming, outgoing) => {
    const cancellation = new AbortController();
    let apiRequest = false;
    const abort = (): void => { if (!cancellation.signal.aborted) { if (apiRequest) disconnects++; cancellation.abort(); } };
    const closed = (): void => { if (!outgoing.writableFinished) abort(); };
    incoming.once("aborted", abort);
    outgoing.once("close", closed);
    active.add(cancellation);
    void (async () => {
      const url = new URL(incoming.url ?? "/", origin);
      if (url.origin !== origin) { outgoing.writeHead(403).end(); return; }
      if (incoming.method === "GET" && url.pathname === "/") {
        outgoing.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }).end('<!doctype html><meta charset="utf-8"><title>MongoDB standalone SDK fixture</title><script type="module" src="/fixture.js"></script>');
        return;
      }
      if (incoming.method === "GET" && url.pathname === "/fixture.js") {
        outgoing.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }).end(bundle.contents);
        return;
      }
      if (incoming.method !== "POST" || !["/api/mongo", "/api/mongo-short"].includes(url.pathname)) { outgoing.writeHead(404).end(); return; }
      apiRequest = true;
      const parts: Uint8Array[] = [];
      let bytes = 0;
      for await (const part of incoming as AsyncIterable<unknown>) {
        assert(part instanceof Uint8Array);
        bytes += part.byteLength;
        if (bytes > 65_536) { outgoing.writeHead(413).end(); return; }
        parts.push(part);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
      const request = new Request(url, { method: "POST", headers, body: Uint8Array.from(Buffer.concat(parts)), signal: cancellation.signal });
      if (request.signal.aborted) requestSignalAborts++;
      else request.signal.addEventListener("abort", () => { requestSignalAborts++; }, { once: true });
      const response = await (url.pathname === "/api/mongo-short" ? shortHandler : handler)(request);
      if (cancellation.signal.aborted || outgoing.destroyed) return;
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
    })().catch(() => { if (!outgoing.destroyed) { if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end(); } }).finally(() => {
      incoming.removeListener("aborted", abort);
      outgoing.removeListener("close", closed);
      active.delete(cancellation);
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 8;
  try {
    await new Promise<void>((resolveListen) => { server.listen(0, "127.0.0.1", resolveListen); });
    const address = server.address();
    assert(address !== null && typeof address !== "string");
    origin = `http://127.0.0.1:${String(address.port)}`;
    // Parent owns this exact page from before mongod startup. Opening another
    // browser/context/page here would invalidate the bounded lifecycle attempt.
    await page.goto(origin);
    await page.waitForFunction("globalThis.mongoFixtureReady === true");
    const basic = await page.evaluate<BasicResult>("globalThis.mongoFixture.basic()");
    assert.deepEqual(basic.document, options.expectedDocument);
    assert.deepEqual(basic.metadata, { kind: "collections", source: "configured", collections: ["products", "mixed"] });
    assert.deepEqual(basic.ids, [options.expectedId, "000000000000000000000003"]);
    assert.equal(basic.finalCursor, null);
    assert.equal(basic.badAppAuth.code, "permission");
    assert.equal(basic.badProviderAuth.code, "authentication");
    assert.equal(basic.overflow.code, "bounds");
    assert.equal(basic.injectionStatus, 400);
    const beforeDisconnect = disconnects;
    const beforeRequestAbort = requestSignalAborts;
    const callerCount = await options.armBlockedRead();
    await page.evaluate("globalThis.mongoFixture.startCaller()");
    await options.waitForBlockedRead(callerCount);
    await page.evaluate("globalThis.mongoFixture.abortCaller()");
    const caller = await page.evaluate<Failure>("globalThis.mongoFixture.finishCaller()");
    assert.equal(caller.name, "QueryCancelledError");
    assert.equal(caller.reason, "caller");
    assert.doesNotMatch(caller.message, /synthetic-secret/u);
    const disconnectDeadline = Date.now() + 1500;
    while (disconnects === beforeDisconnect && Date.now() < disconnectDeadline) await delay(10);
    assert(disconnects > beforeDisconnect, "actual browser HTTP disconnect did not abort the bridged Request.signal");
    assert(requestSignalAborts > beforeRequestAbort, "actual Fetch Request.signal did not observe the connection abort");
    await delay(1100);
    assert.deepEqual(await page.evaluate<unknown>("globalThis.mongoFixture.reopen()"), options.expectedDocument);
    const deadlineCount = await options.armBlockedRead();
    const deadlineResult = page.evaluate<Failure>("globalThis.mongoFixture.deadline()");
    const deadlineAssertion = deadlineResult.then((failure) => {
      assert.equal(failure.name, "QueryCancelledError"); assert.equal(failure.reason, "deadline");
      assert.doesNotMatch(failure.message, /mongodb:|fixture_reader|synthetic-secret/u);
    });
    try { await options.waitForBlockedRead(deadlineCount); }
    finally { await deadlineAssertion; }
    await delay(1100);
    assert.deepEqual(await page.evaluate<unknown>("globalThis.mongoFixture.reopen()"), options.expectedDocument);
    assert.deepEqual(errors, []);
    await sample("after-reopen");
    let kernelPidsPeak: string | null = null;
    try { kernelPidsPeak = (await readFile("/sys/fs/cgroup/pids.peak", "utf8")).trim(); } catch { /* Not exposed on every kernel. */ }
    return { actualStandaloneBrowser: true, browserPreparedBeforeMongod: true, exactPreparedPageReused: true, realTrustedHttp: true, publicBundleBytes: bundle.contents.byteLength, bundleInputs: Object.keys(compiled.metafile.inputs).length, noNodeDriverInBrowser: true, typedEjson: true, configuredMetadata: true, boundedPaging: true, appAuthDenied: true, providerBadAuth: true, endpointInjectionDenied: true, serverObservedDispatch: true, callerCancellationAndDisconnectSignal: true, disconnects, requestSignalAborts, serverDeadlineOverHttp: true, reopen: true, remoteKillIndependentlyObserved: false, applicationUi: false, samples, kernelPidsPeak };
  } catch (error) {
    process.stderr.write(JSON.stringify({ mongoBrowserFailureResourceSamples: samples }) + "\n");
    throw error;
  } finally {
    for (const cancellation of active) cancellation.abort();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolveClose) => { server.close(() => { resolveClose(); }); });
  }
}
