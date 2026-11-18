// Actual installed private SOURCE tarball + explicit trusted-fetch HTTP seam.
// This is not default Snowflake DNS/TLS, an account, warehouse, or browser query.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { collection, Key, UnsupportedError } from "@dalgo/core";
import { QueryCancelledError, isCancellableQueryExecutor } from "@dalgo/adapter-runtime";
import { SnowflakeDatabase, SnowflakeError } from "@dal-go/dalgo2snowflake";

const account = "https://owned.snowflakecomputing.com";
const users = collection("users");
const native = ["9223372036854775807", "1.230000000000000001", "1e+99", "2026-11-02 01:02:03.123456789", "00ff80", '{"n":9223372036854775807}', "null", "", null];
const names = ["ID", "WIDE", "DECIMAL", "EXPONENT", "TIMESTAMP", "BINARY", "VARIANT", "NULL_TEXT", "EMPTY", "NULL"];
const rowType = names.map(name => ({ name, type: "text" }));
const records = new Map([["a", ["a", ...native]], ["b", ["b", ...native]]]);
const dataHash = () => createHash("sha256").update(JSON.stringify([...records])).digest("hex"); const initialHash = dataHash();
const statements = new Map(); const clients = new Set(); const tokens = new Set(); const sockets = new Set(); const socketAcks = new Set();
const failures = []; const waits = new Map();
let closing = false; let phase = "bootstrap"; let requests = 0; let submits = 0; let disconnects = 0; let sequence = 0; let clientId = 0;
function gate() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function bounded(promise, ms = 5000) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("owned Snowflake fixture deadline")), ms); })]); }
  finally { clearTimeout(timer); }
}
function reply(response, status, data) { response.writeHead(status, { "content-type": "application/json", connection: "close" }); response.end(JSON.stringify(data)); }
function result(handle, rows, counts = [rows.length]) {
  return { statementHandle: handle, resultSetMetaData: { numRows: counts.reduce((sum, count) => sum + count, 0), rowType, partitionInfo: counts.map(rowCount => ({ rowCount })) }, data: rows };
}
function uuid() { return `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`; }
const pointSql = 'SELECT * FROM "USERS" WHERE "ID" = ? LIMIT 2';
const querySql = 'SELECT * FROM "USERS" WHERE "ACTIVE" = ? AND "N" IS NULL AND "NAME" IN (?, ?) ORDER BY "NAME" DESC NULLS LAST, "ID" ASC LIMIT 2 OFFSET 0';
const server = createServer((request, response) => {
  void (async () => {
    requests++; assert.ok(requests <= 100);
    assert.equal(request.headers.cookie, undefined); assert.equal(request.headers.accept, "application/json"); assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers["user-agent"], "dalgo2snowflake/0.1.0");
    const authorization = request.headers.authorization; assert.ok(tokens.has(authorization));
    const tokenType = request.headers["x-snowflake-authorization-token-type"]; assert.ok(tokenType === "OAUTH" || tokenType === "KEYPAIR_JWT");
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; assert.ok(size <= 65_536); chunks.push(chunk); }
    // Dispatch ACKs are established only after complete body receipt.
    if (request.url === "/api/v2/statements") {
      assert.equal(request.method, "POST"); submits++;
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.deepEqual(Object.keys(input).sort(), ["bindings", "database", "role", "schema", "statement", "timeout", "warehouse"]);
      assert.equal(input.database, "DB"); assert.equal(input.schema, "PUBLIC"); assert.equal(input.warehouse, "READ_WH"); assert.equal(input.role, "READ_ROLE");
      assert.ok(Number.isSafeInteger(input.timeout) && input.timeout >= 1 && input.timeout <= 120);
      const handle = uuid(); const entry = { authorization, tokenType, cancels: 0, polls: 0, completed: false, cancelReceived: gate(), cancelReaderReleased: gate() }; statements.set(handle, entry);
      if (input.statement === querySql) {
        assert.deepEqual(input.bindings, { "1": { type: "BOOLEAN", value: "true" }, "2": { type: "TEXT", value: "Ada" }, "3": { type: "TEXT", value: "Ben" } });
        entry.kind = phase === "mismatch" ? "mismatch" : "partitioned"; reply(response, 202, { statementHandle: handle, statementStatusUrl: "https://evil.example/PRIVATE_TOKEN" }); return;
      }
      assert.equal(input.statement, pointSql); assert.deepEqual(Object.keys(input.bindings), ["1"]); assert.equal(input.bindings["1"].type, "TEXT");
      const id = input.bindings["1"].value; assert.equal(typeof id, "string"); entry.id = id;
      if (id.startsWith("slow-")) { entry.kind = "slow"; entry.wait = waits.get(id); assert.ok(entry.wait); reply(response, 202, { statementHandle: handle }); return; }
      if (id === "denied") { reply(response, 403, { message: "PRIVATE_SQL_AND_TOKEN", statement: "PRIVATE_SQL" }); return; }
      entry.completed = true;
      const row = records.get(id); reply(response, 200, result(handle, row === undefined ? [] : [row])); return;
    }
    const match = /^\/api\/v2\/statements\/([0-9a-f-]{36})(\/cancel)?(?:\?partition=(\d+))?$/u.exec(request.url);
    assert.ok(match); const entry = statements.get(match[1]); assert.ok(entry);
    if (match[2] === "/cancel") {
      assert.equal(request.method, "POST"); assert.equal(size, 0); assert.equal(match[3], undefined); assert.equal(authorization, entry.authorization); assert.equal(tokenType, entry.tokenType);
      assert.equal(entry.completed, false); assert.equal(++entry.cancels, 1);
      if (entry.wait?.rejected) reply(response, 401, { message: "PRIVATE_CANCEL_FAILURE" }); else reply(response, 200, { statementHandle: match[1], code: "000000", message: "owned fixture cancellation" });
      entry.cancelReceived.resolve(); entry.wait?.cancelled.resolve(entry); return;
    }
    assert.equal(request.method, "GET"); assert.equal(size, 0); entry.polls++;
    if (entry.kind === "slow") {
      assert.equal(match[3], undefined);
      response.once("close", () => { disconnects++; entry.wait.closed.resolve(); }); entry.wait.started.resolve(); return;
    }
    if (entry.kind === "mismatch") { reply(response, 200, { ...result("ffffffff-ffff-4fff-8fff-ffffffffffff", []), statementHandle: "ffffffff-ffff-4fff-8fff-ffffffffffff" }); return; }
    assert.equal(entry.kind, "partitioned");
    if (match[3] !== undefined) {
      const partition = Number(match[3]); assert.ok(partition === 1 || partition === 2); reply(response, 200, { statementHandle: match[1], data: [records.get(partition === 1 ? "a" : "b")] }); return;
    }
    if (entry.polls === 1) { reply(response, 429, { statementHandle: match[1] }); return; }
    assert.equal(entry.polls, 2); entry.completed = true; reply(response, 200, result(match[1], [], [0, 1, 1]));
  })().catch(() => { failures.push("owned SQL API contract mismatch"); if (!response.headersSent) reply(response, 400, { code: "owned-contract-refusal" }); else response.destroy(); });
});
server.on("connection", socket => {
  sockets.add(socket); socketAcks.add(new Promise(resolve => { socket.once("close", () => { sockets.delete(socket); resolve(); }); }));
  socket.on("error", () => undefined); if (closing) socket.destroy();
});
await bounded(new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }));
let succeeded = false;
try {
  const address = server.address(); assert.ok(address && typeof address === "object");
  const local = `http://127.0.0.1:${address.port}`; const requestedUrls = [];
  // Explicit fixture transport: validate the original account URL, remap only
  // path/query to this owned server, and preserve normal Fetch abort/redirect.
  const wireFetch = async (input, init) => {
    assert.equal(typeof input, "string"); const url = new URL(input); assert.equal(url.origin, account); assert.equal(url.hash, ""); assert.equal(init.redirect, "error"); requestedUrls.push(input);
    const value = await fetch(local + url.pathname + url.search, init);
    if (url.pathname.endsWith("/cancel") && value.body !== null) {
      const id = url.pathname.split("/")[4]; const entry = statements.get(id); assert.ok(entry);
      const body = value.body; const getReader = body.getReader.bind(body);
      Object.defineProperty(body, "getReader", { value() {
        const reader = getReader(); const release = reader.releaseLock.bind(reader);
        Object.defineProperty(reader, "releaseLock", { value() { release(); entry.cancelReaderReleased.resolve(); } }); return reader;
      } });
      // Rejected cancel bodies are unused, so their native body cancel is the
      // positive cleanup event rather than a reader-release event.
      const cancel = body.cancel.bind(body); Object.defineProperty(body, "cancel", { value(reason) {
        let pending;
        try { pending = cancel(reason); }
        catch (error) { failures.push("owned native cancel body cleanup threw"); throw error; }
        // Only native fulfillment is an ACK. Preserve the original promise for
        // the adapter while observing rejection without creating an unhandled one.
        void pending.then(() => { entry.cancelReaderReleased.resolve(); }, () => { failures.push("owned native cancel body cleanup rejected"); });
        return pending;
      } });
    }
    return value;
  };
  const make = changes => {
    const id = ++clientId; let count = 0;
    const client = new SnowflakeDatabase({ endpoint: account, database: "DB", schema: "PUBLIC", warehouse: "READ_WH", role: "READ_ROLE", tables: { users: { table: "USERS", idColumn: "ID" } }, timeoutMs: 4000, pollIntervalMs: 0, fetch: wireFetch, ...changes,
      token: signal => {
        count++; assert.ok(signal instanceof AbortSignal); const value = changes?.token === undefined ? `owned-${id}-${count}` : changes.token(signal);
        const admit = token => { assert.equal(typeof token, "string"); tokens.add(`Bearer ${token}`); return token; };
        return typeof value === "string" ? admit(value) : Promise.resolve(value).then(admit);
      } });
    clients.add(client); return { client, calls: () => count };
  };
  const base = make(); const db = base.client; assert.equal(isCancellableQueryExecutor(db), true);
  phase = "point-native-values";
  const point = await db.get(users.key("a")); assert.ok(point.key instanceof Key); assert.equal(point.key.id, "a");
  assert.deepEqual(names.map(name => point.data[name]), records.get("a"));
  const missing = await db.get(users.key("missing")); assert.equal(missing.exists, false);
  const jwt = make({ tokenType: "KEYPAIR_JWT" }); assert.equal((await jwt.client.get(users.key("b"))).exists, true);
  phase = "compiler-polls-partitions";
  const query = users.query().where("ACTIVE", "==", true).where("N", "==", null).where("NAME", "in", ["Ada", "Ben"]).orderBy("NAME", "desc").limit(2).offset(0).build();
  const beforeQuery = requests; const beforeTokens = base.calls();
  const page = await db.query(query); assert.deepEqual(page.records.map(record => record.key.id), ["a", "b"]); assert.equal(page.nextCursor, undefined);
  assert.equal(requests - beforeQuery, 5); assert.equal(base.calls() - beforeTokens, 5); assert.ok(requestedUrls.every(url => url.startsWith(account + "/api/v2/statements")));
  for (const record of page.records) assert.deepEqual(names.slice(1).map(name => record.data[name]), native);
  phase = "snapshot-batch";
  const keys = [users.key("a"), users.key("missing"), users.key("a")];
  const copied = make({ token: () => { keys[1] = users.key("b"); keys.push(users.key("extra")); return "owned-copied"; } });
  const batch = await copied.client.getMany(keys); assert.deepEqual(batch.map(record => record.exists ? record.key.id : null), ["a", null, "a"]);
  phase = "bounds-and-refusals";
  const oneBodyBytes = Buffer.byteLength(JSON.stringify(result("00000000-0000-4000-8000-000000000001", [records.get("a")])));
  const capped = make({ maxResponseBytes: oneBodyBytes + 1 }); const beforeCap = requests;
  await assert.rejects(capped.client.getMany([users.key("a"), users.key("a"), users.key("a")]), SnowflakeError); assert.equal(requests - beforeCap, 2);
  const smallInput = make({ maxRequestBytes: 256 }); const beforeInput = requests; const inputTokens = smallInput.calls();
  await assert.rejects(smallInput.client.query(users.query().where("NAME", "in", ["\u0000".repeat(100), "\u0000".repeat(100)]).build()), SnowflakeError);
  assert.equal(requests, beforeInput); assert.equal(smallInput.calls(), inputTokens);
  let callback = false; const beforeUnsupported = requests;
  await assert.rejects(db.runReadwriteTransaction(() => { callback = true; return Promise.resolve(1); }), UnsupportedError); assert.equal(callback, false); assert.equal(requests, beforeUnsupported);
  const beforeDenied = submits; const rejected = await db.get(users.key("denied")).then(() => undefined, error => error);
  assert.ok(rejected instanceof SnowflakeError); assert.equal(rejected.status, 403); assert.ok(!String(rejected).includes("PRIVATE")); assert.equal(submits - beforeDenied, 1);
  phase = "mismatch";
  const beforeMismatch = requests; await assert.rejects(db.query(query), error => error instanceof SnowflakeError && error.message.includes("Mismatched"));
  const mismatchEntry = [...statements.values()].find(entry => entry.kind === "mismatch"); assert.ok(mismatchEntry);
  await bounded(mismatchEntry.cancelReceived.promise); await bounded(mismatchEntry.cancelReaderReleased.promise); assert.equal(mismatchEntry.cancels, 1); assert.equal(requests - beforeMismatch, 3);
  phase = "physical-cancellation";
  for (const deadline of [false, true]) {
    const id = deadline ? "slow-deadline" : "slow-caller"; const state = { started: gate(), closed: gate(), cancelled: gate() }; waits.set(id, state);
    const instance = make({ timeoutMs: deadline ? 1000 : 4000, maxConcurrent: 1 }); const controller = new AbortController();
    if (!deadline) Object.defineProperty(controller.signal, "aborted", { value: false });
    const outcome = assert.rejects(instance.client.getWithSignal(users.key(id), controller.signal), error => error instanceof QueryCancelledError && error.reason === (deadline ? "deadline" : "caller"));
    await bounded(state.started.promise); if (!deadline) controller.abort("PRIVATE_CAUSE"); await bounded(outcome); await bounded(state.closed.promise);
    const entry = await bounded(state.cancelled.promise); await bounded(entry.cancelReaderReleased.promise); await bounded(new Promise(resolve => setImmediate(resolve)));
    assert.equal(entry.cancels, 1); assert.equal(instance.calls(), 2); assert.equal((await instance.client.get(users.key("a"))).exists, true);
  }
  phase = "cancel-rejected";
  const deniedState = { started: gate(), closed: gate(), cancelled: gate(), rejected: true }; waits.set("slow-rejected", deniedState);
  const deniedCancel = make({ maxConcurrent: 1 }); const caller = new AbortController();
  const denial = assert.rejects(deniedCancel.client.getWithSignal(users.key("slow-rejected"), caller.signal), error => error instanceof QueryCancelledError && error.reason === "caller" && !error.message.includes("PRIVATE"));
  await bounded(deniedState.started.promise); caller.abort(); await bounded(denial); await bounded(deniedState.closed.promise);
  const deniedEntry = await bounded(deniedState.cancelled.promise); await bounded(deniedEntry.cancelReaderReleased.promise); await bounded(new Promise(resolve => setImmediate(resolve)));
  assert.equal(deniedCancel.calls(), 2); assert.equal(deniedEntry.cancels, 1); assert.equal((await deniedCancel.client.get(users.key("b"))).exists, true);
  phase = "private-cancel-race";
  const privateState = { started: gate(), closed: gate(), cancelled: gate() }; waits.set("slow-private-race", privateState);
  const cancelAcquired = gate(); const cancelPulled = gate(); const cancelStopped = gate(); const nativeCancel = gate(); let cancelledReaders = 0; let listenerCalls = 0;
  const cancelBody = new ReadableStream({ pull() { cancelPulled.resolve(); }, cancel() { cancelledReaders++; nativeCancel.resolve(); } }); const cancelResponse = new Response(cancelBody); const nativeReader = cancelBody.getReader.bind(cancelBody);
  Object.defineProperty(cancelBody, "getReader", { value() { const reader = nativeReader(); cancelAcquired.resolve(); return reader; } });
  const privateClient = make({ maxConcurrent: 1, fetch: async (url, init) => {
    if (!url.endsWith("/cancel")) return wireFetch(url, init);
    // The adversary targets the adapter-exposed signal, not Undici's own
    // subscriber. Give the real HTTP leg an independent fixture-owned signal;
    // forward genuine abort intrinsically until its native body is cleaned.
    const wireController = new AbortController();
    const forwardAbort = () => { wireController.abort(); };
    EventTarget.prototype.addEventListener.call(init.signal, "abort", forwardAbort, { once: true });
    try {
      const actual = await wireFetch(url, { ...init, signal: wireController.signal });
      assert.equal(actual.status, 200); await actual.body.cancel();
    } finally { EventTarget.prototype.removeEventListener.call(init.signal, "abort", forwardAbort); }
    const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted").get;
    assert.equal(Reflect.apply(nativeAborted, init.signal, []), false, "adversarial reader must be acquired before the original cleanup deadline");
    EventTarget.prototype.addEventListener.call(init.signal, "abort", () => { cancelStopped.resolve(); }, { once: true });
    Object.defineProperty(init.signal, "addEventListener", { value() { listenerCalls++; } });
    Object.defineProperty(init.signal, "removeEventListener", { value() { throw new Error("PRIVATE_CANCEL_LISTENER"); } });
    return cancelResponse;
  } });
  const privateCaller = new AbortController(); const privateOutcome = assert.rejects(privateClient.client.getWithSignal(users.key("slow-private-race"), privateCaller.signal), error => error instanceof QueryCancelledError && error.reason === "caller");
  await bounded(privateState.started.promise); privateCaller.abort(); await bounded(privateOutcome); await bounded(privateState.closed.promise); await bounded(privateState.cancelled.promise);
  await bounded(cancelAcquired.promise); await bounded(cancelPulled.promise); assert.equal(cancelBody.locked, true); await assert.rejects(privateClient.client.get(users.key("a")), error => error instanceof SnowflakeError && error.message.includes("busy"));
  await bounded(cancelStopped.promise, 3500); await bounded(nativeCancel.promise); assert.equal(cancelledReaders, 1); assert.equal(cancelBody.locked, false); assert.equal(listenerCalls, 0);
  await bounded(new Promise(resolve => setImmediate(resolve))); assert.equal((await privateClient.client.get(users.key("a"))).exists, true);
  assert.equal(disconnects, 4);
  phase = "physical-credential-lease";
  const credentialEntered = gate(); const credential = gate(); const credentialCaller = new AbortController(); let credentialReady = false;
  const waiting = make({ maxConcurrent: 1, token: () => { if (credentialReady) return "owned-reopened-credential"; credentialEntered.resolve(); return credential.promise; } });
  const beforeCredential = requests; const credentialOutcome = assert.rejects(waiting.client.getWithSignal(users.key("a"), credentialCaller.signal), error => error instanceof QueryCancelledError && error.reason === "caller");
  await bounded(credentialEntered.promise); credentialCaller.abort(); await bounded(credentialOutcome); assert.equal(requests, beforeCredential);
  await assert.rejects(waiting.client.get(users.key("a")), error => error instanceof SnowflakeError && error.message.includes("busy"));
  credentialReady = true; credential.resolve("owned-late-credential"); await bounded(new Promise(resolve => setImmediate(resolve))); assert.equal((await waiting.client.get(users.key("a"))).exists, true);
  phase = "late-body-native-reader";
  const late = gate(); const entered = gate(); const cleaned = gate(); const cleanupDone = gate(); const lateCaller = new AbortController(); let ordinary = false;
  let lateCancels = 0; const lateClient = make({ maxConcurrent: 1, fetch: (url, init) => { if (ordinary) return wireFetch(url, init); entered.resolve(); return late.promise; } });
  const stopped = assert.rejects(lateClient.client.getWithSignal(users.key("a"), lateCaller.signal), error => error instanceof QueryCancelledError && error.reason === "caller");
  await bounded(entered.promise); lateCaller.abort(); await bounded(stopped);
  late.resolve(new Response(new ReadableStream({ cancel() { lateCancels++; cleaned.resolve(); return cleanupDone.promise; } })));
  await bounded(cleaned.promise); await assert.rejects(lateClient.client.get(users.key("a")), error => error instanceof SnowflakeError && error.message.includes("busy")); assert.equal(lateCancels, 1);
  ordinary = true; cleanupDone.resolve(); await bounded(new Promise(resolve => setImmediate(resolve))); assert.equal((await lateClient.client.get(users.key("a"))).exists, true);
  const acquired = gate(); const pulled = gate(); const nativeCancelled = gate(); const body = new ReadableStream({ pull() { pulled.resolve(); }, cancel() { nativeCancelled.resolve(); } });
  const ownedResponse = new Response(body); const nativeGetReader = body.getReader.bind(body); let cancels = 0;
  Object.defineProperty(body, "getReader", { value() {
    const reader = nativeGetReader(); const cancel = reader.cancel.bind(reader);
    Object.defineProperty(reader, "cancel", { value(reason) { cancels++; return cancel(reason); } }); acquired.resolve(); return reader;
  } });
  const streamClient = make({ fetch: () => Promise.resolve(ownedResponse) }); const streamCaller = new AbortController();
  const streamOutcome = assert.rejects(streamClient.client.getWithSignal(users.key("a"), streamCaller.signal), error => error instanceof QueryCancelledError && error.reason === "caller");
  await bounded(acquired.promise); await bounded(pulled.promise); assert.equal(body.locked, true); streamCaller.abort(); await bounded(streamOutcome); await bounded(nativeCancelled.promise);
  assert.equal(cancels, 1); assert.equal(body.locked, false);
  assert.equal(dataHash(), initialHash); assert.equal(records.size, 2); assert.equal(failures.length, 0); succeeded = true;
} catch { throw new Error("Owned trusted-fetch Snowflake HTTP fixture failed at " + phase); }
finally {
  let closeFailed = false; for (const client of clients) { try { client.close(); } catch { closeFailed = true; } }
  closing = true; const serverClosed = new Promise(resolve => { server.close(resolve); }); server.closeAllConnections();
  await bounded((async () => { await serverClosed; for (;;) { const count = socketAcks.size; await Promise.all([...socketAcks]); if (count === socketAcks.size) break; } })());
  assert.equal(sockets.size, 0); assert.equal(failures.length, 0); assert.equal(closeFailed, false);
}
assert.equal(succeeded, true);
console.log(JSON.stringify({ publicIdentity: true, existingMappedSql: true, losslessJsonV2: true, snapshotBatch: true, fixedHandlePartitions: true, rotatingOrdinaryCredentials: true, capturedCancelAuthority: true, atMostOneRemoteCancel: true, remoteCancelRejectedUnknown: true, privateCancelRaceTwoSecondStop: true, aggregateBounds: true, noPostRetry: true, afterDispatchCaller: true, afterDispatchDeadline: true, disconnects, reopen: true, credentialWaitPhysicalLease: true, lateBodyPhysicalLease: true, nativeReaderCancel: true, immutableData: true, cleanup: true, trustedFetchHttpFixture: true, actualSnowflakeOrDefaultTlsOrBrowserQuery: false }));
