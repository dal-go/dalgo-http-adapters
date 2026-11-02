// Actual private SOURCE tarball + owned loopback HTTP. No Azure, CORS or engine.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Key, key, UnsupportedError } from "@dalgo/core";
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import {
  NativeCosmosNoSqlDatabase, NativeCosmosError, NativeCosmosHttpError, NativeCosmosJsonNumber,
  nativeCosmosResourceToken, nativeCosmosAadToken, nativeCosmosNumber,
  encodeNativeCosmosJson, decodeNativeCosmosJson,
} from "@dal-go/dalgo2cosmosdb";

const rawResource = "type=resource&ver=1.0&sig=owned+/=";
const resourceHeader = encodeURIComponent(rawResource);
const aadHeader = "type=aad&ver=1.0&sig=owned.aad-token";
const partition = "tenant:a";
const originalId = "original-%id";
const feed = "/dbs/fixture/colls/records/docs";
function rawDocument(id) {
  return '{"id":' + JSON.stringify(id) + ',"tenant":"tenant:a","_etag":"owned-revision","wide":9223372036854775807,"fraction":1.230000000000000001,"exponent":1e+99,"zero":-0,"optional":null,"nested":[true,"😀"],"__proto__":{"own":"native"}}';
}
const documents = new Map([originalId, "first", "second"].map(id => [id, rawDocument(id)]));
const dataHash = () => createHash("sha256").update(JSON.stringify([...documents])).digest("hex");
const initialDataHash = dataHash();
function gate() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function bounded(promise, timeoutMs = 4000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("owned native HTTP fixture deadline")), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
function body(response, status, value, extra = {}) {
  response.writeHead(status, { "content-type": "application/json", connection: "close", ...extra }); response.end(value);
}
function queryBody(response, ids, continuation, session) {
  for (const id of ids) assert.ok(documents.has(id));
  body(response, 200, '{"Documents":[' + ids.map(id => documents.get(id)).join(",") + '],"_count":' + ids.length + '}', {
    "x-ms-request-charge": "1.2500", "x-ms-item-count": String(ids.length),
    ...(continuation === undefined ? {} : { "x-ms-continuation": continuation }),
    ...(session === undefined ? {} : { "x-ms-session-token": session }),
  });
}
const pending = new Map(); const sockets = new Set(); const closeAcks = new Set();
const clients = new Set(); const contractFailures = [];
let closing = false; let requests = 0; let disconnects = 0; let phase = "bootstrap";
const server = createServer((request, response) => {
  void (async () => {
    requests++; assert.ok(requests <= 64);
    assert.ok(request.headers.authorization === resourceHeader || request.headers.authorization === aadHeader);
    assert.equal(request.headers.cookie, undefined); assert.equal(request.headers.accept, "application/json");
    assert.equal(request.headers["x-ms-version"], "2018-12-31"); assert.ok(Number.isFinite(Date.parse(request.headers["x-ms-date"])));
    assert.equal(request.headers["x-ms-documentdb-partitionkey"], '["tenant:a"]');
    assert.equal(request.headers["x-ms-documentdb-query-enablecrosspartition"], undefined);
    const chunks = []; let size = 0;
    // Consume complete input BEFORE acknowledging dispatch/disconnect ownership.
    for await (const chunk of request) { size += chunk.length; assert.ok(size <= 65_536); chunks.push(chunk); }
    if (request.method === "GET") {
      assert.ok(request.url.startsWith(feed + "/")); assert.equal(size, 0);
      const suffix = request.url.slice(feed.length + 1); const id = decodeURIComponent(suffix);
      assert.equal(encodeURIComponent(id), suffix);
      assert.equal(request.headers["x-ms-consistency-level"], undefined); assert.equal(request.headers["x-ms-session-token"], undefined);
      const waiting = pending.get(id);
      if (waiting !== undefined) {
        response.once("close", () => { disconnects++; pending.delete(id); waiting.closed.resolve(); });
        waiting.started.resolve(); return;
      }
      if (id === "missing") { body(response, 404, '{"private":"PRIVATE_UNUSED_BODY"}'); return; }
      if (id === "denied") { body(response, 403, '{"private":"PRIVATE_REMOTE_CAUSE"}'); return; }
      if (id === "throttled") { body(response, 429, '{"private":"PRIVATE_REMOTE_CAUSE"}', { "x-ms-retry-after-ms": "25", "x-ms-request-charge": "0" }); return; }
      assert.ok(documents.has(id));
      body(response, 200, documents.get(id), { "x-ms-session-token": "owned-seed", "x-ms-request-charge": "1.2500", "x-ms-activity-id": "owned-activity" }); return;
    }
    assert.equal(request.method, "POST"); assert.equal(request.url, feed);
    assert.equal(request.headers["content-type"], "application/query+json"); assert.equal(request.headers["x-ms-documentdb-isquery"], "True");
    const count = Number(request.headers["x-ms-max-item-count"]); assert.ok(count >= 1 && count <= 2);
    const raw = Buffer.concat(chunks).toString("utf8");
    assert.ok(raw.includes('"value":9223372036854775807'));
    const query = decodeNativeCosmosJson(raw);
    assert.equal(query.query, "SELECT * FROM c WHERE c.mode = @mode AND c.wide >= @wide");
    assert.equal(query.parameters.length, 2); assert.equal(query.parameters[0].name, "@mode");
    assert.equal(query.parameters[1].name, "@wide"); assert.equal(query.parameters[1].value.lexeme, "9223372036854775807");
    const mode = query.parameters[0].value; const position = request.headers["x-ms-continuation"];
    if (mode === "paging") {
      assert.equal(count, 1); assert.equal(request.headers["x-ms-consistency-level"], undefined); assert.equal(request.headers["x-ms-session-token"], undefined);
      if (position === undefined) queryBody(response, ["first"], "owned-page-one", "owned-observed");
      else { assert.equal(position, "owned-page-one"); queryBody(response, ["second"]); }
      return;
    }
    assert.ok(mode === "default" || mode === "explicit");
    if (mode === "default") {
      assert.equal(request.headers["x-ms-consistency-level"], undefined); assert.equal(request.headers["x-ms-session-token"], undefined);
    } else {
      assert.equal(request.headers["x-ms-consistency-level"], "Session");
      assert.equal(request.headers["x-ms-session-token"], position === undefined ? "owned-seed" : "owned-latest");
    }
    if (position === undefined) queryBody(response, [], "owned-empty-position", "owned-latest");
    else { assert.equal(position, "owned-empty-position"); queryBody(response, [originalId], undefined, "owned-final"); }
  })().catch(() => {
    contractFailures.push("owned native HTTP contract mismatch");
    if (!response.headersSent) body(response, 400, '{"code":"owned-contract-refusal"}'); else response.destroy();
  });
});
server.on("connection", socket => {
  sockets.add(socket);
  closeAcks.add(new Promise(resolve => { socket.once("close", () => { sockets.delete(socket); resolve(); }); }));
  socket.on("error", () => undefined); if (closing) socket.destroy();
});
await bounded(new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }));
let succeeded = false;
try {
  const address = server.address(); assert.ok(address && typeof address === "object"); let tokenCalls = 0;
  const options = {
    endpoint: `http://127.0.0.1:${address.port}`, databaseId: "fixture", containerId: "records", partitionKeyField: "tenant", authScopeId: "trusted-fixture-user",
    timeoutMs: 3000, pageSize: 2, maxResponseBytes: 16_384, collections: { items: { partition } },
    authorization: request => {
      tokenCalls++; assert.equal(request.resourceType, "docs"); assert.ok(request.signal instanceof AbortSignal); assert.equal(request.signal.aborted, false);
      assert.equal(request.authScopeId, "trusted-fixture-user"); assert.equal(request.resourceLink, request.resourcePath.endsWith("/docs") ? "dbs/fixture/colls/records" : request.resourcePath);
      return nativeCosmosResourceToken(rawResource);
    },
  };
  const make = changes => { const client = new NativeCosmosNoSqlDatabase({ ...options, ...changes }); clients.add(client); return client; };
  const db = make(); const nativeKey = { id: originalId, partition };
  phase = "native-point-codec";
  const result = await db.getNative(nativeKey); assert.deepEqual(result.document.key, nativeKey);
  assert.equal(encodeNativeCosmosJson(result.document.data), documents.get(originalId));
  assert.ok(result.document.data.wide instanceof NativeCosmosJsonNumber); assert.equal(result.document.data.wide.lexeme, "9223372036854775807");
  assert.equal(result.document.data.fraction.lexeme, "1.230000000000000001"); assert.equal(result.document.data.exponent.lexeme, "1e+99"); assert.equal(result.document.data.zero.lexeme, "-0");
  assert.equal(result.document.data.optional, null); assert.equal(Object.getPrototypeOf(result.document.data), null); assert.equal(Object.hasOwn(result.document.data, "__proto__"), true); assert.equal(Object.prototype.own, undefined);
  assert.equal(result.metadata.requestCharge.lexeme, "1.2500"); assert.equal(result.document.metadata.etag, "owned-revision");
  const coreKey = key("items", originalId); const bridged = await db.get(coreKey);
  assert.equal(bridged.key, coreKey); assert.ok(bridged.key instanceof Key); assert.equal(bridged.exists, true); assert.equal(bridged.data.wide.lexeme, "9223372036854775807");
  const beforeRefusal = requests; let callback = false;
  await assert.rejects(db.insert(coreKey, {}), UnsupportedError);
  await assert.rejects(db.runReadwriteTransaction(() => { callback = true; return Promise.resolve(1); }), UnsupportedError);
  assert.equal(callback, false); assert.equal(requests, beforeRefusal);
  const aad = make({ authorization: () => nativeCosmosAadToken("owned.aad-token") }); assert.equal((await aad.getNative(nativeKey)).document.key.id, originalId);
  phase = "copied-native-batch";
  const keys = [{ ...nativeKey }, { id: "missing", partition }, { ...nativeKey }];
  const copied = make({ fetch: (url, init) => { keys[1] = { id: "changed", partition: "foreign" }; return fetch(url, init); } });
  const batch = await copied.getManyNative(keys); assert.deepEqual(batch.documents.map(document => document?.key.id ?? null), [originalId, null, originalId]);
  assert.equal(batch.metadata[1].requestCharge, undefined); assert.equal((await db.getManyNative([])).documents.length, 0);
  phase = "native-query-cursor";
  const query = mode => ({ sql: "SELECT * FROM c WHERE c.mode = @mode AND c.wide >= @wide", partition, limit: 1, parameters: [{ name: "@mode", value: mode }, { name: "@wide", value: nativeCosmosNumber("9223372036854775807") }] });
  const first = await db.queryNative(query("paging")); assert.equal(first.documents[0].key.id, "first"); assert.ok(first.nextCursor);
  assert.ok(!JSON.stringify(first.nextCursor).includes("owned-page")); const beforeBadScope = requests; const beforeBadScopeTokens = tokenCalls;
  await assert.rejects(db.queryNative({ ...query("paging"), limit: 2, cursor: first.nextCursor }), error => error instanceof NativeCosmosError && error.code === "cursor"); assert.equal(requests, beforeBadScope); assert.equal(tokenCalls, beforeBadScopeTokens);
  const second = await db.queryNative({ ...query("paging"), cursor: first.nextCursor }); assert.equal(second.documents[0].key.id, "second"); assert.equal(second.nextCursor, undefined);
  await assert.rejects(db.queryNative({ ...query("paging"), cursor: first.nextCursor }), error => error instanceof NativeCosmosError && error.code === "cursor");
  phase = "native-session-opt-in";
  const plain = await db.queryNative(query("default")); assert.equal(plain.pages, 2); assert.equal(plain.documents[0].key.id, originalId);
  const explicit = await db.queryNative(query("explicit"), { session: result.metadata.session }); assert.equal(explicit.pages, 2);
  assert.ok(!JSON.stringify(explicit).includes("owned-latest"));
  phase = "native-budget-and-errors";
  const capped = make({ maxResponseBytes: Buffer.byteLength(documents.get(originalId)) + 1 }); const beforeBudget = requests;
  await assert.rejects(capped.getManyNative([nativeKey, nativeKey, nativeKey]), error => error instanceof NativeCosmosError && error.code === "bounds"); assert.equal(requests - beforeBudget, 2);
  for (const id of ["denied", "throttled"]) {
    const failure = await db.getNative({ id, partition }).then(() => undefined, error => error);
    assert.ok(failure instanceof NativeCosmosHttpError); assert.ok(!String(failure).includes("PRIVATE"));
    if (id === "throttled") { assert.equal(failure.status, 429); assert.equal(failure.retryAfterMs, 25); assert.equal(failure.metadata.requestCharge.lexeme, "0"); }
  }
  phase = "native-credential-lease";
  const broker = gate(); const entered = gate(); const caller = new AbortController();
  const waiting = make({ maxConcurrent: 1, authorization: () => { entered.resolve(); return broker.promise; } });
  const stopped = assert.rejects(waiting.getNative(nativeKey, { signal: caller.signal }), error => error instanceof QueryCancelledError && error.reason === "caller");
  await bounded(entered.promise); caller.abort("PRIVATE_CALLER_CAUSE"); await bounded(stopped);
  await assert.rejects(waiting.getNative(nativeKey), error => error instanceof NativeCosmosError && error.code === "busy");
  broker.resolve(nativeCosmosResourceToken(rawResource)); await bounded(new Promise(resolve => setImmediate(resolve)));
  assert.equal((await waiting.getNative(nativeKey)).document.key.id, originalId);
  phase = "native-dispatched-cancellation";
  for (const deadline of [false, true]) {
    const id = deadline ? "slow-deadline" : "slow-caller"; const held = { started: gate(), closed: gate() }; pending.set(id, held);
    const client = make({ timeoutMs: deadline ? 1000 : 3000 }); const controller = new AbortController();
    if (!deadline) Object.defineProperty(controller.signal, "aborted", { value: false });
    const outcome = assert.rejects(client.getNative({ id, partition }, { signal: controller.signal }), error => error instanceof QueryCancelledError && error.reason === (deadline ? "deadline" : "caller") && !error.message.includes("PRIVATE"));
    await bounded(held.started.promise);
    if (!deadline) controller.abort("PRIVATE_CALLER_CAUSE");
    await bounded(outcome); await bounded(held.closed.promise);
    assert.equal((await client.getNative(nativeKey)).document.key.id, originalId);
  }
  assert.equal(disconnects, 2); assert.equal(contractFailures.length, 0); assert.equal(documents.size, 3); assert.equal(dataHash(), initialDataHash); assert.ok(tokenCalls > 0);
  phase = "complete"; succeeded = true;
} catch { throw new Error("Owned native Cosmos packed fixture failed at " + phase); }
finally {
  let closeFailed = false;
  for (const client of clients) { try { client.close(); } catch { closeFailed = true; } }
  closing = true; const serverClosed = new Promise(resolve => { server.close(resolve); }); server.closeAllConnections();
  await bounded((async () => {
    await serverClosed;
    for (;;) { const count = closeAcks.size; await Promise.all([...closeAcks]); if (count === closeAcks.size) break; }
  })());
  assert.equal(sockets.size, 0); assert.equal(pending.size, 0); assert.equal(contractFailures.length, 0); assert.equal(closeFailed, false);
}
assert.equal(succeeded, true);
console.log(JSON.stringify({ nativeOriginalDocuments: true, losslessNumericLexemes: true, resourceAndAadHeaders: true, parameterizedSinglePartition: true, opaqueCursorScope: true, explicitSessionOnly: true, copiedOrderedBatch: true, aggregateBudget: true, credentialWaitAndPhysicalLease: true, callerAfterDispatch: true, deadlineAfterDispatch: true, disconnects, reopen: true, immutableFixtureData: true, cleanup: true, actualCosmosOrAzure: false }));
