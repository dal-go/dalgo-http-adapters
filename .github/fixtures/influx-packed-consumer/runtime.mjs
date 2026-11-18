// Account-free SQL HTTP protocol fixture for the actual PRIVATE source tarball.
// This is not an InfluxDB engine, Cloud, CORS or wide-number fidelity proof.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { collection, key, Key, UnsupportedError } from "@dalgo/core";
import { QueryCancelledError, isCancellableQueryExecutor } from "@dalgo/adapter-runtime";
import { InfluxDB3Database, InfluxDB3HttpError, InfluxDB3TransportError } from "@dal-go/dalgo2influxdb";

const token = "owned-fixture-read-token";
const first = { __dalgo_key: "one", title: "Milk", done: false, rank: 10 };
const second = { __dalgo_key: "two", title: "Tea", done: false, rank: 11 };
const sockets = new Set(); const acknowledgements = [];
let closing = false; let requests = 0; let observed; let responseClosed;
async function bounded(promise, milliseconds = 2500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("owned SQL HTTP fixture deadline")), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
const server = createServer((request, response) => {
  void (async () => {
    requests++;
    assert.equal(request.method, "POST"); assert.equal(request.url, "/api/v3/query_sql");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers.cookie, undefined);
    const chunks = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 4096); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.deepEqual(Object.keys(body).sort(), ["db", "format", "params", "q"]);
    assert.equal(body.db, "fixture"); assert.equal(body.format, "json");
    assert.equal(typeof body.q, "string"); assert.ok(body.params !== null && typeof body.params === "object" && !Array.isArray(body.params));
    assert.ok(body.q.startsWith('SELECT t."id" AS "__dalgo_key", t."title" AS "title", t."done" AS "done", t."rank" AS "rank" FROM "items" AS t'));
    assert.ok(body.q.endsWith(" LIMIT 2"));
    let rows;
    if (typeof body.params.p0 === "string") {
      assert.ok(body.q.includes('WHERE t."id" = $p0'));
      assert.ok(!body.q.includes("'" + body.params.p0.replaceAll("'", "''") + "'"), "key values must remain bound parameters");
      if (body.params.p0.startsWith("slow-")) {
        response.once("close", () => responseClosed?.()); observed?.(); return;
      }
      rows = body.params.p0 === "one" ? [first] : body.params.p0 === "two" ? [second] : [];
    } else {
      assert.equal(body.params.p0, false);
      assert.ok(body.q.includes('WHERE t."done" = $p0'));
      assert.ok(body.q.includes('ORDER BY t."rank" ASC, t."id" ASC'));
      if (Object.hasOwn(body.params, "c0")) { assert.equal(body.params.c0, 10); assert.equal(body.params.c1, "one"); rows = [second]; }
      else rows = [first, second];
    }
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(rows));
  })().catch(() => { response.writeHead(401, { "content-type": "text/plain" }); response.end("owned-secret-provider-body"); });
});
server.on("connection", socket => {
  sockets.add(socket);
  acknowledgements.push(new Promise(resolve => { socket.once("close", () => { sockets.delete(socket); resolve(); }); }));
  socket.on("error", () => undefined); if (closing) socket.destroy();
});
await bounded(new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }));
try {
  const address = server.address(); assert.ok(address && typeof address === "object");
  const options = { database: "fixture", serverUrl: `http://127.0.0.1:${address.port}`, accessToken: () => token, timeoutMs: 500, maxRows: 10, maxResponseBytes: 4096, tables: { items: { table: "items", keyColumn: { column: "id", nullable: false }, columns: { title: { column: "title" }, done: { column: "done", nullable: false }, rank: { column: "rank", nullable: false } } } } };
  const db = new InfluxDB3Database(options); assert.ok(isCancellableQueryExecutor(db));
  const requested = key("items", "one");
  const found = await db.get(requested);
  assert.equal(found.key, requested); assert.ok(found.key instanceof Key);
  assert.deepEqual(found.data, { title: "Milk", done: false, rank: 10 });
  const many = await db.getMany([key("items", "two"), key("items", "missing"), requested]);
  assert.deepEqual(many.map(row => row.exists ? row.data.title : null), ["Tea", null, "Milk"]);
  const items = collection("items");
  const page = await db.query(items.query().where("done", "==", false).orderBy("rank").limit(1).build());
  assert.equal(page.records.length, 1); assert.equal(page.records[0].key.id, "one"); assert.ok(page.records[0].key instanceof Key);
  assert.deepEqual(page.nextCursor?.values, [10, "one"]);
  const after = await db.query(items.query().where("done", "==", false).orderBy("rank").limit(1).startAfter(...page.nextCursor.values).build());
  assert.equal(after.records.length, 1); assert.equal(after.records[0].key.id, "two"); assert.equal(after.nextCursor, undefined);
  const before = requests; let callbackRan = false;
  await assert.rejects(db.insert(requested, {}), UnsupportedError);
  await assert.rejects(db.runReadwriteTransaction(async () => { callbackRan = true; }), UnsupportedError);
  assert.equal(callbackRan, false); assert.equal(requests, before);
  const bad = new InfluxDB3Database({ ...options, accessToken: () => "wrong-fixture-token" });
  await assert.rejects(bad.get(requested), error => error instanceof InfluxDB3HttpError && error.status === 401 && !/secret|token|127\.0\.0\.1/u.test(error.message));
  const brokenToken = new InfluxDB3Database({ ...options, accessToken: () => { throw new Error("owned-secret-token-cause"); } });
  await assert.rejects(brokenToken.get(requested), error => error instanceof InfluxDB3TransportError && !/secret|token|127\.0\.0\.1/u.test(error.message));
  for (const deadline of [false, true]) {
    const caller = new AbortController();
    const dispatched = new Promise(resolve => { observed = resolve; });
    const disconnected = new Promise(resolve => { responseClosed = resolve; });
    const work = db.getWithSignal(key("items", deadline ? "slow-deadline" : "slow-caller"), caller.signal);
    const rejected = assert.rejects(work, error => error instanceof QueryCancelledError && error.reason === (deadline ? "deadline" : "caller") && !error.message.includes("owned-secret-caller-cause"));
    await bounded(dispatched); if (!deadline) caller.abort(new Error("owned-secret-caller-cause"));
    await bounded(rejected); await bounded(disconnected);
    assert.deepEqual((await db.get(requested)).data, { title: "Milk", done: false, rank: 10 });
  }
  // Deterministic synchronous-callback deadline boundary: no sleep or CPU spin.
  // If a timer-only implementation dispatches, the zero-fetch assertion fails
  // even if a delayed real timer subsequently rejects the operation.
  const previousClock = Object.getOwnPropertyDescriptor(performance, "now");
  let now = 0; let lateFetches = 0;
  Object.defineProperty(performance, "now", { configurable: true, value: () => now });
  try {
    const elapsed = new InfluxDB3Database({ ...options, timeoutMs: 10, accessToken: () => { now = 11; return token; }, fetch: () => { lateFetches++; return Promise.resolve(new Response(JSON.stringify([first]), { headers: { "content-type": "application/json" } })); } });
    await assert.rejects(elapsed.get(requested), error => error instanceof QueryCancelledError && error.reason === "deadline");
    assert.equal(lateFetches, 0);
  } finally { if (previousClock === undefined) delete performance.now; else Object.defineProperty(performance, "now", previousClock); }
} finally {
  observed = undefined; responseClosed = undefined; closing = true;
  const serverClosed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const complete = bounded((async () => { await serverClosed; await Promise.all(acknowledgements); })());
  for (const socket of sockets) socket.destroy();
  server.closeAllConnections(); server.closeIdleConnections(); await complete;
  assert.equal(sockets.size, 0, "owned HTTP fixture sockets remain");
}
console.log(JSON.stringify({ coreAndErrorIdentity: true, servedSqlContract: true, typedKeys: true, paging: true, refusalBeforeDispatch: true, callerAfterDispatch: true, deadlineAfterDispatch: true, elapsedDeadlineGuard: true, disconnect: true, reopen: true, cleanup: true, actualInfluxOrCloud: false }));
