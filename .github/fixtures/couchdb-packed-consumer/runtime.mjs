// Real installed SOURCE tarball, owned HTTP protocol fixture. Not CouchDB server,
// browser query, CORS, hosted authorization or production write qualification.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { collection, key, Key, UnsupportedError, AlreadyExistsError } from "@dalgo/core";
import { QueryCancelledError, isCancellableQueryExecutor } from "@dalgo/adapter-runtime";
import { CouchDbDatabase, NativeCouchDbDatabase, CouchDbHttpError, CouchDbRequestError, CouchDbConflictError, CouchDbBatchSizeError } from "@dalgo/dalgo2couchdb";

const readerToken = "Bearer owned-synthetic-reader"; const writerToken = "Bearer owned-synthetic-writer";
const domain = id => ({ title: id === "a" ? "Milk" : "Tea", status: "open", done: false, n: 42.25, nullable: null, list: ["json", 2] });
const encoded = id => Buffer.from(JSON.stringify(["items", id])).toString("base64url");
const native = id => ({ _id: id, _rev: "1-owned", ...domain(id) });
const managed = (id, revision = "1-owned", data = domain(id)) => ({ _id: encoded(id), _rev: revision, __dalgo_collection: "items", __dalgo_id: id, data });
const documents = { native: new Map(["a", "b"].map(id => [id, native(id)])), managed: new Map(["a", "b"].map(id => [id, managed(id)])) };
const initial = JSON.stringify(Object.fromEntries(Object.entries(documents).map(([mode, rows]) => [mode, [...rows]])));
function gate() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function bounded(promise, milliseconds = 3000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("owned Couch HTTP fixture deadline")), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
const holds = new Map(); const repeatBookmarkOnce = new Set(["native", "managed"]); const sockets = new Set(); const socketAcks = []; const contractFailures = [];
let closing = false; let requests = 0;
const json = (response, status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
const server = createServer((request, response) => {
  void (async () => {
    requests++;
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.accept, "application/json");
    const url = new URL(request.url, "http://127.0.0.1"); const pieces = url.pathname.split("/"); const mode = pieces[1];
    assert.ok(mode === "native" || mode === "managed");
    const token = request.headers.authorization; assert.ok(token === readerToken || token === writerToken);
    const chunks = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 8192); chunks.push(chunk); }
    const body = bytes === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (request.method === "GET" && pieces.length === 2) {
      assert.equal(mode, "native"); json(response, 200, { db_name: "native", doc_count: 2, doc_del_count: 0, update_seq: "owned-sequence", compact_running: false, sizes: { active: 100, external: 200, file: 300 } }); return;
    }
    if (request.method === "GET" && pieces[2] === "_index") {
      assert.equal(mode, "native"); json(response, 200, { indexes: [{ ddoc: "_design/status-id", name: "status-id-index", type: "json", def: { fields: [{ status: "asc" }, { _id: "asc" }] }, partitioned: false }] }); return;
    }
    if (request.method === "GET" && pieces[2] === "_all_docs") {
      assert.equal(mode, "native"); assert.equal(url.searchParams.get("include_docs"), "true"); assert.equal(url.searchParams.get("limit"), "2");
      json(response, 200, { rows: [...documents.native].map(([id, doc]) => ({ id, key: id, value: { rev: doc._rev }, doc })) }); return;
    }
    if (request.method === "POST") {
      assert.equal(pieces[2], "_find"); assert.equal(request.headers["content-type"], "application/json");
      assert.equal(body.limit, 1);
      if (mode === "native") {
        assert.deepEqual(body.selector, { $and: [{ status: { $eq: "open" } }] });
        assert.deepEqual(body.sort, [{ status: "asc" }, { _id: "asc" }]);
        assert.deepEqual(body.use_index, ["_design/status-id", "status-id-index"]); assert.equal(body.allow_fallback, false);
      } else {
        assert.deepEqual(body.selector, { $and: [{ __dalgo_collection: { $eq: "items" } }, { "data.done": { $eq: false } }] });
        assert.equal(body.sort, undefined);
      }
      if (body.bookmark === undefined) json(response, 200, { docs: [documents[mode].get("a")], bookmark: "owned-next" });
      else { assert.equal(body.bookmark, "owned-next"); if (repeatBookmarkOnce.delete(mode)) json(response, 200, { docs: [documents[mode].get("b")], bookmark: "owned-next" }); else json(response, 200, { docs: [], bookmark: "owned-final" }); }
      return;
    }
    assert.equal(pieces.length, 3); assert.equal(url.search, "");
    const physical = decodeURIComponent(pieces[2]); let id;
    if (mode === "native") id = physical;
    else { const parts = JSON.parse(Buffer.from(physical, "base64url").toString("utf8")); assert.equal(parts[0], "items"); id = parts[1]; assert.equal(physical, encoded(id)); }
    assert.equal(typeof id, "string");
    if (request.method === "GET") {
      const hold = holds.get(mode + ":" + id);
      if (hold !== undefined) { response.once("close", () => { hold.closed.resolve(); }); hold.dispatched.resolve(); return; }
      if (id === "denied-after-sibling") {
        const sibling = holds.get(mode + ":held-sibling"); assert.ok(sibling); await bounded(sibling.dispatched.promise); json(response, 403, { private: "owned-secret-provider-body" }); return;
      }
      if (id === "denied") { json(response, 403, { private: "owned-secret-provider-body" }); return; }
      if (id === "mvcc-race") { assert.equal(mode, "managed"); json(response, 200, managed(id, "3-owned")); return; }
      const found = documents[mode].get(id); json(response, found === undefined ? 404 : 200, found ?? { error: "not_found" }); return;
    }
    assert.equal(mode, "managed"); assert.equal(token, writerToken);
    if (request.method === "PUT") {
      assert.equal(body._id, physical); assert.equal(body.__dalgo_collection, "items"); assert.equal(body.__dalgo_id, id);
      assert.ok(body.data !== null && typeof body.data === "object");
      if (id === "mvcc-race") { assert.equal(body._rev, "3-owned"); json(response, 409, { error: "conflict", private: "owned-secret-conflict" }); return; }
      assert.equal(id, "owned-write"); const old = documents.managed.get(id);
      if ((old === undefined && body._rev !== undefined) || (old !== undefined && body._rev !== old._rev)) { json(response, 409, { error: "conflict" }); return; }
      const revision = old === undefined ? "1-owned" : "2-owned"; documents.managed.set(id, { ...body, _rev: revision });
      json(response, 201, { ok: true, id: physical, rev: revision }); return;
    }
    assert.equal(request.method, "DELETE"); assert.equal(id, "owned-write"); const old = documents.managed.get(id); assert.ok(old);
    assert.equal(request.headers["if-match"], old._rev); documents.managed.delete(id); json(response, 200, { ok: true });
  })().catch(() => {
    contractFailures.push("owned Couch HTTP request contract mismatch");
    if (!response.headersSent) json(response, 400, { error: "owned-contract-refusal" }); else response.destroy();
  });
});
server.on("connection", socket => {
  sockets.add(socket); socketAcks.push(new Promise(resolve => socket.once("close", () => { sockets.delete(socket); resolve(); })));
  socket.on("error", () => undefined); if (closing) socket.destroy();
});
await bounded(new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }));
try {
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const baseOptions = mode => ({ databaseUrl: origin + "/" + mode, headers: signal => { assert.ok(signal instanceof AbortSignal); signal.throwIfAborted(); return { authorization: readerToken }; }, timeoutMs: 1000, maxResponseBytes: 8192, maxSampleDocuments: 2, collection: "items", permittedIndexes: [{ ddoc: "_design/status-id", name: "status-id-index", fields: [{ field: "status", direction: "asc" }, { field: "_id", direction: "asc" }] }] });
  const create = (mode, extra = {}) => mode === "native" ? new NativeCouchDbDatabase({ ...baseOptions(mode), ...extra }) : new CouchDbDatabase({ ...baseOptions(mode), ...extra });
  const items = collection("items");
  const query = mode => mode === "native" ? items.query().where("status", "==", "open").orderBy("status").limit(1) : items.query().where("done", "==", false).limit(1);
  for (const mode of ["native", "managed"]) {
    const beforeConstructor = requests; const db = create(mode); assert.equal(requests, beforeConstructor); assert.ok(isCancellableQueryExecutor(db));
    const a = key("items", "a"); const found = await db.get(a); assert.equal(found.key, a); assert.ok(found.key instanceof Key); assert.equal(found.exists, true);
    assert.deepEqual(found.data, mode === "native" ? native("a") : domain("a")); assert.deepEqual(found.metadata, mode === "native" ? { id: "a", revision: "1-owned" } : { revision: "1-owned" });
    const many = await db.getMany([key("items", "b"), key("items", "missing"), a, a]);
    assert.deepEqual(many.map(row => row.exists ? row.data.title : null), ["Tea", null, "Milk", "Milk"]); assert.ok(many.every(row => row.key instanceof Key));
    const first = await db.query(query(mode).build()); assert.equal(first.records.length, 1); assert.equal(first.records[0].key.id, "a"); assert.ok(first.nextCursor);
    const beforeRefusal = requests;
    await assert.rejects(create(mode).query(query(mode).startAfter(...first.nextCursor.values).build()), TypeError);
    const wrong = mode === "native" ? items.query().where("status", "==", "closed").orderBy("status").limit(1) : items.query().where("done", "==", true).limit(1);
    await assert.rejects(db.query(wrong.startAfter(...first.nextCursor.values).build()), TypeError); assert.equal(requests, beforeRefusal);
    await assert.rejects(db.query(query(mode).startAfter(...first.nextCursor.values).build()), /did not advance/u);
    const next = await db.query(query(mode).startAfter(...first.nextCursor.values).build()); assert.deepEqual(next.records, []);
    if (mode === "native") { await assert.rejects(db.query(query(mode).startAfter(...first.nextCursor.values).build()), /already been used/u); assert.equal(requests, beforeRefusal + 2); }
    let callbackRan = false; const beforeUnsupported = requests;
    await assert.rejects(db.runReadwriteTransaction(async () => { callbackRan = true; }), UnsupportedError); assert.equal(callbackRan, false);
    if (mode === "native") for (const mutate of [() => db.insert(a, {}), () => db.set(a, {}), () => db.update(a, {}), () => db.delete(a)]) await assert.rejects(mutate(), UnsupportedError);
    assert.equal(requests, beforeUnsupported);
    await assert.rejects(db.get(key("items", "denied")), error => error instanceof CouchDbHttpError && error.status === 403 && !/owned-secret|127\.0\.0\.1/u.test(error.message));
    const preabort = new AbortController(); preabort.abort("owned-secret-cause"); const beforeAbort = requests;
    await assert.rejects(db.getWithSignal(a, preabort.signal), error => error instanceof QueryCancelledError && error.reason === "caller"); assert.equal(requests, beforeAbort);
    for (const deadline of [false, true]) {
      const id = deadline ? "held-deadline" : "held-caller"; const hold = { dispatched: gate(), closed: gate() }; holds.set(mode + ":" + id, hold);
      const caller = new AbortController(); const rejected = assert.rejects(db.getWithSignal(key("items", id), caller.signal), error => error instanceof QueryCancelledError && error.reason === (deadline ? "deadline" : "caller") && error.cause === undefined);
      await bounded(hold.dispatched.promise); if (!deadline) caller.abort("owned-secret-cause"); await bounded(rejected); await bounded(hold.closed.promise); holds.delete(mode + ":" + id);
      assert.equal((await db.get(a)).exists, true);
    }
    const credentialEntered = gate(); const credentialAborted = gate(); const credentialCaller = new AbortController(); const beforeCredentials = requests;
    const waiting = create(mode, { headers: signal => new Promise((_, reject) => { signal.addEventListener("abort", () => { credentialAborted.resolve(); reject(new Error("owned-secret-header-cause")); }, { once: true }); credentialEntered.resolve(); }) });
    const stopped = assert.rejects(waiting.getWithSignal(a, credentialCaller.signal), error => error instanceof QueryCancelledError && error.reason === "caller");
    await bounded(credentialEntered.promise); credentialCaller.abort(); await bounded(stopped); await bounded(credentialAborted.promise); assert.equal(requests, beforeCredentials);
    const failed = create(mode, { headers: () => { throw new Error("owned-secret-header-cause"); } });
    await assert.rejects(failed.get(a), error => error instanceof CouchDbRequestError && !error.message.includes("owned-secret") && error.cause === undefined);
    const size = Buffer.byteLength(JSON.stringify(mode === "native" ? native("a") : managed("a"))); const whole = create(mode, { maxParallelReads: 1, maxGetManyBytes: size * 2 - 1 });
    let decoded = 0; const beforeBudget = requests;
    await assert.rejects(whole.getMany([a, a, a], { encode: value => value, decode: value => { decoded++; return value; } }), mode === "native" ? CouchDbBatchSizeError : RangeError);
    assert.equal(decoded, 1); assert.equal(requests - beforeBudget, 2);
    const sibling = { dispatched: gate(), closed: gate() }; holds.set(mode + ":held-sibling", sibling); const parallel = create(mode, { maxParallelReads: 2 }); const beforeSiblings = requests;
    const denied = assert.rejects(parallel.getMany([key("items", "denied-after-sibling"), key("items", "held-sibling"), a]), error => error instanceof CouchDbHttpError && error.status === 403);
    await bounded(sibling.dispatched.promise); await bounded(denied); await bounded(sibling.closed.promise); holds.delete(mode + ":held-sibling"); assert.equal(requests - beforeSiblings, 2); assert.equal((await parallel.get(a)).exists, true);

    // Monotonic callback-driven original deadline, without sleeping/spinning.
    const previousClock = Object.getOwnPropertyDescriptor(performance, "now"); let now = 0; let headers = 0; const beforeClock = requests;
    Object.defineProperty(performance, "now", { configurable: true, value: () => now });
    try {
      const original = create(mode, { maxParallelReads: 1, headers: () => { now = ++headers === 1 ? 400 : 1001; return { authorization: readerToken }; } });
      await assert.rejects(original.getMany([a, a]), error => error instanceof QueryCancelledError && error.reason === "deadline"); assert.equal(headers, 2); assert.equal(requests - beforeClock, 1);
    } finally { if (previousClock === undefined) delete performance.now; else Object.defineProperty(performance, "now", previousClock); }

    const received = gate(); const release = gate(); const cleaned = gate(); const lateCaller = new AbortController(); let bodyCancels = 0;
    const delayed = create(mode, { fetch: async (url, init) => {
      // Fixture intentionally ignores the signal to prove the adapter's local
      // race/late-body ownership independently of native fetch cancellation.
      const request = { ...init }; delete request.signal; const response = await fetch(url, request); assert.ok(response.body);
      const cancel = response.body.cancel.bind(response.body); response.body.cancel = (...args) => { bodyCancels++; cleaned.resolve(); return cancel(...args); };
      received.resolve(); await release.promise; return response;
    } });
    const lateOutcome = assert.rejects(delayed.getWithSignal(a, lateCaller.signal), error => error instanceof QueryCancelledError && error.reason === "caller");
    try { await bounded(received.promise); lateCaller.abort(); await bounded(lateOutcome); release.resolve(); await bounded(cleaned.promise); assert.equal(bodyCancels, 1); }
    finally { release.resolve(); lateCaller.abort(); }

    const acquired = gate(); const readerCleaned = gate(); const acquireCaller = new AbortController(); let readerCancels = 0; let ownedBody;
    const acquiring = create(mode, { fetch: async (url, init) => {
      const response = await fetch(url, init); const body = response.body; assert.ok(body); ownedBody = body;
      const getReader = body.getReader.bind(body); body.getReader = (...args) => {
        const reader = getReader(...args); const cancel = reader.cancel.bind(reader);
        reader.cancel = (...values) => { readerCancels++; readerCleaned.resolve(); return cancel(...values); };
        acquired.resolve(); acquireCaller.abort("owned-secret-acquisition"); return reader;
      };
      return response;
    } });
    const acquisition = assert.rejects(acquiring.getWithSignal(a, acquireCaller.signal), error => error instanceof QueryCancelledError && error.reason === "caller" && error.cause === undefined);
    await bounded(acquired.promise); await bounded(acquisition); await bounded(readerCleaned.promise); assert.equal(readerCancels, 1); assert.equal(ownedBody.locked, false);
  }
  const db = create("native"); const connection = await db.testConnection(); assert.equal(connection.ok, true); assert.equal(connection.database.database, "native");
  const indexes = await db.listIndexes(); assert.equal(indexes.status, "available"); assert.equal(indexes.indexes[0].name, "status-id-index");
  const fields = await db.sampleFields(); assert.equal(fields.status, "sampled"); assert.equal(fields.sampleSize, 2); assert.equal(fields.truncated, true); assert.ok(fields.fields.includes("_id"));
  const described = await db.describe(); assert.equal(described.storage, "native-rows"); assert.equal(described.database.ok, true); assert.equal(described.indexes.status, "available");
  const transform = { encode: value => value, decode: value => { value._id = "transformed-data"; delete value._rev; return value; } };
  const transformed = await db.get(key("items", "a"), transform); assert.equal(transformed.key.id, "a"); assert.deepEqual(transformed.metadata, { id: "a", revision: "1-owned" }); assert.equal(transformed.data._id, "transformed-data");
  const typed = collection("items", { codec: transform }); const changed = await db.query(typed.query().where("status", "==", "open").orderBy("status").limit(1).build());
  assert.equal(changed.records[0].key.id, "a"); assert.deepEqual(changed.records[0].metadata, { id: "a", revision: "1-owned" }); assert.equal(changed.records[0].data._id, "transformed-data");
  const writer = create("managed", { headers: () => ({ authorization: writerToken }) }); const written = key("items", "owned-write");
  await writer.insert(written, { title: "owned-write", done: false }); await assert.rejects(writer.insert(written, { title: "conflict" }), AlreadyExistsError);
  await writer.set(written, { title: "updated-owned-write", done: false }); const afterWrite = await writer.get(written); assert.equal(afterWrite.metadata.revision, "2-owned"); assert.equal(afterWrite.data.title, "updated-owned-write");
  await assert.rejects(writer.set(key("items", "mvcc-race"), { title: "never-overwrite" }), CouchDbConflictError);
  await writer.delete(written); assert.equal((await writer.get(written)).exists, false);
  assert.equal(JSON.stringify(Object.fromEntries(Object.entries(documents).map(([mode, rows]) => [mode, [...rows]]))), initial, "owned fixture native/managed seed state changed after cleanup");
  assert.equal(contractFailures.length, 0, "owned HTTP contract assertions failed");
} finally {
  closing = true; const serverClosed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const done = bounded((async () => { await serverClosed; await Promise.all(socketAcks); })());
  for (const socket of sockets) socket.destroy(); server.closeAllConnections(); server.closeIdleConnections(); await done; assert.equal(sockets.size, 0);
}
console.log(JSON.stringify({ coreAndErrorIdentity: true, servedHttpContract: true, nativeAndManagedReads: true, nativeJsonAndMetadata: true, indexSortedQuery: true, scopedBookmarks: true, bookmarkProgress: true, nativeMetadata: true, managedMvccProtocol: true, callerAfterDispatch: true, deadlineAfterDispatch: true, credentialWait: true, aggregateBudget: true, siblingAbort: true, originalBatchDeadline: true, lateBodyCleanup: true, readerAcquisitionCleanup: true, disconnect: true, reopen: true, cleanup: true, actualCouchDB: false, actualBrowser: false }));
