// Actual private packed Cosmos managed-layout source, owned NoSQL HTTP wire.
// No emulator/account, RU/consistency, real browser, CORS or native-document proof.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { collection, key, Key, UnsupportedError } from "@dalgo/core";
import { QueryCancelledError, isCancellableQueryExecutor } from "@dalgo/adapter-runtime";
import { CosmosNoSqlDatabase, CosmosHttpError, CosmosTransportError } from "@dal-go/dalgo2cosmosdb";

const token = "type=resource&ver=1.0&sig=owned-fixture-read";
const feed = "/dbs/fixture/colls/records/docs";
function encoded(id) { return Buffer.from(JSON.stringify(id)).toString("base64url"); }
function managed(id) {
  return { id: encoded(id), __dalgo_collection: "items", __dalgo_id: id, __dalgo_partition: "items", data: { title: id === "one" ? "Milk" : "Tea", done: false, n: 42.25, optional: null, list: ["json", 2] }, _etag: "owned-etag", _ts: 123 };
}
function gate() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function bounded(promise, milliseconds = 2500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("owned NoSQL HTTP fixture deadline")), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
const sockets = new Set(); const closeAcks = []; const pendingReads = new Map(); const contractFailures = [];
let closing = false; let requests = 0;
function json(response, status, body, extra = {}) { response.writeHead(status, { "content-type": "application/json", ...extra }); response.end(JSON.stringify(body)); }
const server = createServer((request, response) => {
  void (async () => {
    requests++;
    assert.equal(request.headers.authorization, token);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.accept, "application/json");
    assert.equal(request.headers["x-ms-version"], "2018-12-31");
    assert.ok(Number.isFinite(Date.parse(request.headers["x-ms-date"])));
    assert.equal(request.headers["x-ms-documentdb-partitionkey"], '["items"]');
    const chunks = []; let bytes = 0;
    // Body EOF precedes dispatch acknowledgement; fixture never relies on
    // disconnect detection while an unread POST body still hides the socket.
    for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 8192); chunks.push(chunk); }
    if (request.method === "GET") {
      assert.ok(request.url.startsWith(feed + "/")); assert.equal(bytes, 0);
      const suffix = request.url.slice(feed.length + 1); const id = JSON.parse(Buffer.from(suffix, "base64url").toString("utf8"));
      assert.equal(suffix, encoded(id)); assert.equal(typeof id, "string");
      const pending = pendingReads.get(id);
      if (pending !== undefined) {
        response.once("close", () => { pending.closed.resolve(); });
        pending.dispatched.resolve(); return;
      }
      if (id === "denied-after-sibling") {
        const sibling = pendingReads.get("slow-sibling"); assert.ok(sibling);
        await bounded(sibling.dispatched.promise);
        json(response, 403, { private: "owned-secret-response-body" }); return;
      }
      if (id === "denied") { json(response, 403, { private: "owned-secret-response-body" }); return; }
      if (id === "missing") { json(response, 404, { private: "unused-owned-error-body" }); return; }
      assert.ok(id === "one" || id === "two"); json(response, 200, managed(id)); return;
    }
    assert.equal(request.method, "POST"); assert.equal(request.url, feed);
    assert.equal(request.headers["content-type"], "application/query+json");
    assert.equal(request.headers["x-ms-documentdb-isquery"], "True");
    assert.equal(request.headers["x-ms-max-item-count"], "2");
    assert.equal(request.headers["x-ms-documentdb-is-upsert"], undefined);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.deepEqual(body, { query: 'SELECT * FROM c WHERE c.__dalgo_collection = @collection AND c.data["done"] = @p0', parameters: [{ name: "@collection", value: "items" }, { name: "@p0", value: false }] });
    if (request.headers["x-ms-continuation"] === undefined) json(response, 200, { Documents: [], _count: 0 }, { "x-ms-continuation": "owned-next" });
    else { assert.equal(request.headers["x-ms-continuation"], "owned-next"); json(response, 200, { Documents: [managed("one"), managed("two")], _count: 2 }); }
  })().catch(() => {
    // Do not print headers, token, endpoint or full provider diagnostics even
    // when an assertion fails; terminal fixture verdict retains the failure.
    contractFailures.push("owned NoSQL HTTP request contract mismatch");
    if (!response.headersSent) json(response, 400, { code: "owned-contract-refusal" }); else response.destroy();
  });
});
server.on("connection", socket => {
  sockets.add(socket);
  closeAcks.push(new Promise(resolve => { socket.once("close", () => { sockets.delete(socket); resolve(); }); }));
  socket.on("error", () => undefined); if (closing) socket.destroy();
});
await bounded(new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }));
try {
  const address = server.address(); assert.ok(address && typeof address === "object");
  let tokenCalls = 0;
  const options = { endpoint: `http://127.0.0.1:${address.port}`, databaseId: "fixture", containerId: "records", timeoutMs: 1000, maxResponseBytes: 8192,
    authorization: request => { tokenCalls++; assert.equal(request.resourceType, "docs"); assert.ok(request.signal instanceof AbortSignal); assert.equal(request.signal.aborted, false); assert.equal(request.resourceLink, request.resourcePath.endsWith("/docs") ? "dbs/fixture/colls/records" : request.resourcePath); return token; },
  };
  const db = new CosmosNoSqlDatabase(options); assert.ok(isCancellableQueryExecutor(db)); assert.equal(requests, 0); assert.equal(tokenCalls, 0);
  const one = key("items", "one"); const found = await db.get(one);
  assert.equal(found.key, one); assert.ok(found.key instanceof Key); assert.equal(found.exists, true);
  assert.deepEqual(found.data, managed("one").data); assert.deepEqual(found.metadata, { etag: "owned-etag", timestamp: 123 });
  const rows = await db.getMany([key("items", "two"), key("items", "missing"), one, one]);
  assert.deepEqual(rows.map(row => row.exists ? row.data.title : null), ["Tea", null, "Milk", "Milk"]);
  assert.ok(rows.every(row => row.key instanceof Key));
  const items = collection("items"); const q = () => items.query().where("done", "==", false).limit(2);
  const page = await db.query(q().build()); assert.deepEqual(page.records, []); assert.ok(page.nextCursor);
  const beforeCursorRefusals = requests;
  await assert.rejects(db.query(items.query().where("done", "==", true).limit(2).startAfter(...page.nextCursor.values).build()), TypeError);
  await assert.rejects(db.query(q().limit(1).startAfter(...page.nextCursor.values).build()), TypeError);
  await assert.rejects(new CosmosNoSqlDatabase(options).query(q().startAfter(...page.nextCursor.values).build()), TypeError);
  assert.equal(requests, beforeCursorRefusals);
  const next = await db.query(q().startAfter(...page.nextCursor.values).build());
  assert.deepEqual(next.records.map(row => row.key.id), ["one", "two"]); assert.deepEqual(next.records.map(row => row.data), [managed("one").data, managed("two").data]); assert.equal(next.nextCursor, undefined);
  const before = requests; let callbackRan = false;
  await assert.rejects(db.update(one, { done: true }), UnsupportedError);
  await assert.rejects(db.runReadwriteTransaction(async () => { callbackRan = true; }), UnsupportedError);
  assert.equal(callbackRan, false); assert.equal(requests, before);
  await assert.rejects(db.get(key("items", "denied")), error => error instanceof CosmosHttpError && error.status === 403 && !/owned-secret|127\.0\.0\.1/u.test(error.message));
  const preabort = new AbortController(); preabort.abort("owned-secret-caller-cause"); const beforeAbort = requests; const beforeToken = tokenCalls;
  await assert.rejects(db.getWithSignal(one, preabort.signal), error => error instanceof QueryCancelledError && error.reason === "caller"); assert.equal(requests, beforeAbort); assert.equal(tokenCalls, beforeToken);

  for (const deadline of [false, true]) {
    const id = deadline ? "slow-deadline" : "slow-caller"; const owned = { dispatched: gate(), closed: gate() }; pendingReads.set(id, owned);
    const caller = new AbortController();
    const rejected = assert.rejects(db.getWithSignal(key("items", id), caller.signal), error => error instanceof QueryCancelledError && error.reason === (deadline ? "deadline" : "caller") && !error.message.includes("owned-secret-caller-cause"));
    await bounded(owned.dispatched.promise); if (!deadline) caller.abort(new Error("owned-secret-caller-cause"));
    await bounded(rejected); await bounded(owned.closed.promise); pendingReads.delete(id);
    assert.deepEqual((await db.get(one)).data, managed("one").data);
  }

  const credentialEntered = gate(); const credentialAborted = gate(); const caller = new AbortController(); const beforeCredentials = requests;
  const waiting = new CosmosNoSqlDatabase({ ...options, authorization: request => new Promise((_, reject) => {
    request.signal.addEventListener("abort", () => { credentialAborted.resolve(); reject(new Error("owned-secret-credential-cause")); }, { once: true });
    credentialEntered.resolve();
  }) });
  const noToken = assert.rejects(waiting.getWithSignal(one, caller.signal), error => error instanceof QueryCancelledError && error.reason === "caller");
  await bounded(credentialEntered.promise); caller.abort(); await bounded(noToken); await bounded(credentialAborted.promise); assert.equal(requests, beforeCredentials);
  const failedToken = new CosmosNoSqlDatabase({ ...options, authorization: () => { throw new Error("owned-secret-token-cause"); } });
  await assert.rejects(failedToken.get(one), error => error instanceof CosmosTransportError && !/secret|127\.0\.0\.1/u.test(error.message) && error.cause === undefined); assert.equal(requests, beforeCredentials);

  const whole = new CosmosNoSqlDatabase({ ...options, maxParallelReads: 1, maxResponseBytes: Buffer.byteLength(JSON.stringify(managed("one"))) * 2 - 1 });
  const beforeBudget = requests;
  await assert.rejects(whole.getMany([one, one, one]), error => error instanceof RangeError && error.message.includes("maxResponseBytes"));
  assert.equal(requests - beforeBudget, 2, "whole batch stops before the third read on aggregate overflow");
  const sibling = { dispatched: gate(), closed: gate() }; pendingReads.set("slow-sibling", sibling);
  const parallel = new CosmosNoSqlDatabase({ ...options, maxParallelReads: 2 }); const beforeSiblings = requests;
  const failure = assert.rejects(parallel.getMany([key("items", "denied-after-sibling"), key("items", "slow-sibling"), one]), error => error instanceof CosmosHttpError && error.status === 403);
  await bounded(sibling.dispatched.promise); await bounded(failure); await bounded(sibling.closed.promise); pendingReads.delete("slow-sibling");
  assert.equal(requests - beforeSiblings, 2, "sibling failure prevents any later batch"); assert.deepEqual((await parallel.get(one)).data, managed("one").data);

  const previousClock = Object.getOwnPropertyDescriptor(performance, "now"); let now = 0; let lateFetches = 0;
  Object.defineProperty(performance, "now", { configurable: true, value: () => now });
  try {
    const elapsed = new CosmosNoSqlDatabase({ ...options, timeoutMs: 10, authorization: () => { now = 11; return token; }, fetch: () => { lateFetches++; return Promise.resolve(new Response(JSON.stringify(managed("one")))); } });
    await assert.rejects(elapsed.get(one), error => error instanceof QueryCancelledError && error.reason === "deadline"); assert.equal(lateFetches, 0);
  } finally { if (previousClock === undefined) delete performance.now; else Object.defineProperty(performance, "now", previousClock); }
  const codecAbort = new AbortController();
  await assert.rejects(db.getWithSignal(one, codecAbort.signal, { encode: value => value, decode: value => { codecAbort.abort("owned-secret-codec-cause"); return value; } }), error => error instanceof QueryCancelledError && error.reason === "caller");
  assert.equal(contractFailures.length, 0, "owned HTTP server contract assertions failed");
} finally {
  closing = true;
  const serverClosed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const complete = bounded((async () => { await serverClosed; await Promise.all(closeAcks); })());
  for (const socket of sockets) socket.destroy(); server.closeAllConnections(); server.closeIdleConnections(); await complete;
  assert.equal(sockets.size, 0, "owned NoSQL HTTP fixture sockets remain");
}
console.log(JSON.stringify({ coreAndErrorIdentity: true, servedNoSqlContract: true, managedKeys: true, paging: true, queryScopedCursor: true, refusalBeforeDispatch: true, callerAfterDispatch: true, deadlineAfterDispatch: true, elapsedDeadlineGuard: true, credentialWait: true, aggregateBudget: true, siblingAbort: true, disconnect: true, reopen: true, cleanup: true, actualCosmosOrCloud: false }));
