// Actual packed SDK + owned public-function HTTP wire, not a Convex backend,
// JWT issuer/IAM certification, CORS, installed release or browser query proof.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { Key, collection } from "@dalgo/core";
import { QueryCancelledError, isCancellableQueryExecutor } from "@dalgo/adapter-runtime";
import { ConvexDatabase, ConvexReadError, CONVEX_CAPABILITIES } from "@dalgo/dalgo2convex";
import { convexToJson, jsonToConvex } from "convex/values";

let phase = "setup";
const tokenOne = randomBytes(32).toString("base64url"), tokenTwo = randomBytes(32).toString("base64url");
const privateDetail = "private-wire-provider-detail";
const data = [
  { _id: "a", _creationTime: 1.25, tenant: "one", title: "<native>&", min: -9223372036854775808n, max: 9223372036854775807n, amount: 9007199254740993n, bytes: new Uint8Array([0, 255, 128]).buffer, score: NaN, infinite: Infinity, negative: -Infinity, zero: -0, nested: [false, null, "astral-😀"] },
  { _id: "b", _creationTime: 2.5, tenant: "one", title: "second", amount: -9223372036854775808n, bytes: new Uint8Array([1]).buffer, score: 0.25, done: true },
];
const dataHash = () => createHash("sha256").update(JSON.stringify(convexToJson(data))).digest("hex");
const initialHash = dataHash();
const sockets = new Set(), closeAcknowledgements = [], slow = new Map();
let closing = false, requests = 0, queryRequests = 0, pointRequests = 0, protocolFailures = 0, redirects = 0;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function bounded(promise, maximum = 2500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("owned fixture bound exceeded")), maximum); })]); }
  finally { clearTimeout(timer); }
}
function response(value) {
  return new Response(JSON.stringify({ status: "success", value: convexToJson(value) }), { headers: { "content-type": "application/json" } });
}
function issued(page) { assert.equal(typeof page.nextCursor, "string"); return page.nextCursor; }
// Native Convex records may legitimately have a null prototype. Compare only
// their lossless official value semantics; never coerce bigint/bytes/IEEE data.
function sameNative(actual, expected) {
  assert.deepEqual(jsonToConvex(convexToJson(actual)), jsonToConvex(convexToJson(expected)));
}
async function rejectsSafe(pending, predicate) {
  await assert.rejects(pending, error => {
    assert.ok(error instanceof Error); assert.equal(Object.hasOwn(error, "cause"), false);
    for (const value of [tokenOne, tokenTwo, privateDetail, "private-caller-cause", "private-token-cause"]) assert.ok(!error.message.includes(value), "secret entered safe error");
    return predicate(error);
  });
}
const server = createServer({ requestTimeout: 5000, headersTimeout: 3000, keepAliveTimeout: 2000, maxHeaderSize: 32768 }, (request, reply) => {
  void (async () => {
    if (request.url === "/redirect-target") { redirects++; reply.writeHead(500); reply.end(); return; }
    requests++;
    assert.equal(request.method, "POST"); assert.equal(request.url, "/api/query");
    assert.equal(request.headers["content-type"], "application/json"); assert.equal(request.headers.cookie, undefined);
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; assert.ok(size <= 65_536); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.deepEqual(Object.keys(body).sort(), ["args", "format", "path"]);
    assert.equal(body.format, "convex_encoded_json");
    assert.ok(Array.isArray(body.args) && body.args.length === 1);
    const args = jsonToConvex(body.args[0]);
    assert.ok(args !== null && typeof args === "object" && !Array.isArray(args));
    assert.ok(body.path === "dalgo:getTask" || body.path === "dalgo:listTasks");
    if (body.path === "dalgo:getTask") pointRequests++; else queryRequests++;
    reply.setHeader("content-type", "application/json");
    const send = value => { reply.end(JSON.stringify({ status: "success", value: convexToJson(value), logLines: [privateDetail] })); };
    const deny = status => { reply.writeHead(status); reply.end(JSON.stringify({ status: "error", errorMessage: privateDetail, errorData: privateDetail, logLines: [privateDetail] })); };
    const identity = request.headers.authorization === "Bearer " + tokenOne ? "one"
      : request.headers.authorization === "Bearer " + tokenTwo ? "two" : undefined;
    if (identity === undefined) { deny(401); return; }
    if (args.tenant !== identity || identity !== "one") { deny(403); return; }
    if (body.path === "dalgo:getTask") {
      assert.deepEqual(Object.keys(args).sort(), ["id", "tenant"]); assert.equal(typeof args.id, "string");
      if (args.id.startsWith("slow-")) {
        const observation = slow.get(args.id); assert.ok(observation);
        reply.once("close", () => { if (!reply.writableFinished) observation.disconnected.resolve(); });
        observation.dispatched.resolve(); return;
      }
      switch (args.id) {
        case "wire:denied": deny(403); return;
        case "wire:redirect": reply.writeHead(302, { location: "/redirect-target" }); reply.end(); return;
        case "wire:malformed": reply.end('{"status":"success","value":'); return;
        case "wire:foreign": send({ _id: "foreign-private-id" }); return;
        case "wire:oversize": send({ _id: args.id, large: "x".repeat(8192) }); return;
      }
      send(data.find(row => row._id === args.id) ?? null); return;
    }
    assert.deepEqual(Object.keys(args).sort(), ["filter", "paginationOpts", "tenant"]);
    assert.deepEqual(args.filter, { amount: 9007199254740993n, bytes: new Uint8Array([0, 255]).buffer, score: NaN });
    const paging = args.paginationOpts;
    assert.ok(paging !== null && typeof paging === "object" && !Array.isArray(paging));
    assert.equal(paging.numItems, 1);
    assert.equal(paging.maximumRowsRead, 1000);
    assert.ok(Number.isSafeInteger(paging.maximumBytesRead) && paging.maximumBytesRead > 0 && paging.maximumBytesRead <= 4096);
    if (paging.cursor === null) send({ page: [], isDone: false, continueCursor: "native-one" });
    else if (paging.cursor === "native-one") send({ page: [data[0]], isDone: false, continueCursor: "native-two" });
    else { assert.equal(paging.cursor, "native-two"); send({ page: [data[1]], isDone: true, continueCursor: "" }); }
  })().catch(() => {
    protocolFailures++;
    if (!reply.headersSent) reply.writeHead(500, { "content-type": "application/json" });
    reply.end('{"status":"error","errorMessage":"owned protocol assertion failed"}');
  });
});
server.on("connection", socket => {
  sockets.add(socket);
  closeAcknowledgements.push(new Promise(resolve => { socket.once("close", () => { sockets.delete(socket); resolve(); }); }));
  socket.on("error", () => undefined);
  if (closing) socket.destroy();
});
server.on("clientError", (_error, socket) => { socket.destroy(); });

async function main() {
  await bounded(new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }));
  const instances = [];
  try {
    const address = server.address(); assert.ok(address !== null && typeof address === "object");
    const base = {
      endpoint: "http://127.0.0.1:" + address.port, allowInsecureLoopbackHttp: true,
      token: tokenOne, timeoutMs: 500, maxRows: 20, maxResponseBytes: 4096,
      collections: { tasks: { getFunction: "dalgo:getTask", staticArgs: { tenant: "one" }, fields: [{ name: "amount", type: "int64" }] } },
      queries: { tasks: { path: "dalgo:listTasks", collection: "tasks", arguments: ["filter"], staticArgs: { tenant: "one" } } },
    };
    const create = extra => { const instance = new ConvexDatabase({ ...base, ...extra }); instances.push(instance); return instance; };
    let current = tokenOne;
    const db = create({ token: () => current });
    assert.ok(isCancellableQueryExecutor(db));
    assert.equal(db.metadata().provenance, "trusted-configuration"); assert.equal(db.metadata().dynamicDiscovery, false);
    assert.equal(CONVEX_CAPABILITIES.writes, "NOT_IMPLEMENTED");
    phase = "served-native-values-core-identity";
    const found = await db.get(new Key("tasks", "a"));
    assert.ok(found.key instanceof Key); assert.equal(found.key.id, "a"); assert.equal(found.exists, true);
    sameNative(found.data, data[0]); assert.ok(Object.is(found.data.zero, -0)); assert.ok(found.data.bytes instanceof ArrayBuffer);
    assert.equal(typeof found.data.amount, "bigint"); assert.ok(Number.isNaN(found.data.score));
    const many = await db.getMany([new Key("tasks", "b"), new Key("tasks", "missing"), new Key("tasks", "a"), new Key("tasks", "a")]);
    assert.deepEqual(many.map(row => row.exists ? row.data._id : null), ["b", null, "a", "a"]);
    sameNative(many[2].data, data[0]); sameNative(many[3].data, data[0]);
    assert.notEqual(many[2].data, many[3].data);
    assert.notEqual(many[2].data.bytes, many[3].data.bytes);
    new Uint8Array(many[2].data.bytes)[0] = 99;
    assert.equal(new Uint8Array(many[3].data.bytes)[0], 0);
    assert.equal(new Uint8Array(data[0].bytes)[0], 0);
    assert.equal(await db.exists(new Key("tasks", "a")), true); assert.equal(await db.exists(new Key("tasks", "missing")), false);
    await db.testConnection(new Key("tasks", "a"));
    phase = "native-paging-authscope-and-byte-for-byte-encoded-arguments";
    const args = { filter: { amount: 9007199254740993n, bytes: new Uint8Array([0, 255]).buffer, score: NaN } };
    const first = await db.queryFunction("tasks", args, { pageSize: 1 });
    assert.deepEqual(first.documents, []); assert.equal(first.isDone, false); assert.notEqual(issued(first), "native-one");
    const beforeScope = requests;
    current = tokenTwo;
    await rejectsSafe(db.queryFunction("tasks", args, { pageSize: 1, cursor: issued(first) }), error => error instanceof ConvexReadError && error.code === "cursor");
    assert.equal(requests, beforeScope); current = tokenOne;
    const second = await db.queryFunction("tasks", args, { pageSize: 1, cursor: issued(first) });
    sameNative(second.documents, [data[0]]);
    const third = await db.queryFunction("tasks", args, { pageSize: 1, cursor: issued(second) });
    sameNative(third, { documents: [data[1]], isDone: true });
    const beforeLocal = requests; let callbackRan = false;
    await rejectsSafe(db.query(collection("tasks").query().limit(1).build()), error => error instanceof ConvexReadError && error.code === "not-implemented");
    await rejectsSafe(db.runReadwriteTransaction(async () => { callbackRan = true; }), error => error instanceof ConvexReadError && error.code === "not-implemented");
    assert.equal(callbackRan, false);
    await rejectsSafe(db.queryFunction("tasks", { tenant: "override" }), error => error instanceof ConvexReadError && error.code === "invalid-input");
    const preabort = new AbortController(); preabort.abort("private-caller-cause");
    await rejectsSafe(db.getWithSignal(new Key("tasks", "a"), preabort.signal), error => error instanceof QueryCancelledError && error.reason === "caller");
    const badSupplier = create({ token: () => { throw new Error("private-token-cause"); } });
    await rejectsSafe(badSupplier.get(new Key("tasks", "a")), error => error instanceof ConvexReadError && error.code === "transport");
    assert.equal(requests, beforeLocal);
    phase = "provider-auth-and-protocol-refusals";
    const bad = create({ token: "wrong-user-jwt" });
    await rejectsSafe(bad.get(new Key("tasks", "a")), error => error instanceof ConvexReadError && error.code === "denied");
    const wrongTenant = create({ collections: { tasks: { getFunction: "dalgo:getTask", staticArgs: { tenant: "two" } } } });
    await rejectsSafe(wrongTenant.get(new Key("tasks", "a")), error => error instanceof ConvexReadError && error.code === "denied");
    for (const id of ["wire:denied", "wire:redirect", "wire:oversize", "wire:malformed", "wire:foreign"]) {
      await rejectsSafe(db.get(new Key("tasks", id)), error => error instanceof ConvexReadError);
    }
    phase = "server-observed-caller-deadline-disconnect-reopen";
    for (const deadline of [false, true]) {
      const caller = new AbortController(), id = deadline ? "slow-deadline" : "slow-caller";
      const observation = { dispatched: deferred(), disconnected: deferred() }; slow.set(id, observation);
      const rejection = rejectsSafe(db.getWithSignal(new Key("tasks", id), caller.signal), error => error instanceof QueryCancelledError && error.reason === (deadline ? "deadline" : "caller"));
      await bounded(observation.dispatched.promise);
      if (!deadline) caller.abort("private-caller-cause");
      await bounded(rejection); await bounded(observation.disconnected.promise);
      sameNative((await db.get(new Key("tasks", "a"))).data, data[0]);
    }
    phase = "physical-borrowed-lease-after-public-abort";
    for (const stage of ["auth", "fetch"]) {
      const entered = deferred(), held = deferred(), caller = new AbortController();
      let attempts = 0, once = true;
      const cancel = () => new Promise(() => undefined);
      const scoped = create({
        maxConcurrent: 1,
        token: stage === "auth" ? () => { if (once) { once = false; entered.resolve(); return held.promise; } return tokenOne; } : tokenOne,
        fetch: () => {
          attempts++;
          if (stage === "fetch" && once) { once = false; entered.resolve(); return held.promise; }
          return Promise.resolve(response({ _id: "a" }));
        },
      });
      const rejection = rejectsSafe(scoped.getWithSignal(new Key("tasks", "a"), caller.signal), error => error instanceof QueryCancelledError && error.reason === "caller");
      await bounded(entered.promise); caller.abort("private-caller-cause"); await bounded(rejection);
      await rejectsSafe(scoped.get(new Key("tasks", "a")), error => error instanceof ConvexReadError && error.code === "busy");
      assert.equal(attempts, stage === "auth" ? 0 : 1);
      if (stage === "auth") held.reject(new Error("private late token cause"));
      else held.resolve(new Response(new ReadableStream({ cancel })));
      await new Promise(resolve => { setImmediate(resolve); });
      assert.equal((await scoped.get(new Key("tasks", "a"))).exists, true);
    }
    phase = "final-immutable-data";
    assert.equal(protocolFailures, 0); assert.equal(redirects, 0);
    assert.equal(requests, 22); assert.equal(requests, pointRequests + queryRequests);
    assert.equal(dataHash(), initialHash);
  } finally {
    for (const db of instances) db.close();
    closing = true;
    // Register positive connection-close ACKs before destroy, and stop accepting
    // first. Neither server.close nor the socket registry is assumed synchronous.
    const serverClosed = new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); });
    const done = bounded((async () => { await serverClosed; await Promise.all(closeAcknowledgements); })());
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections(); server.closeIdleConnections(); await done;
    assert.equal(sockets.size, 0, "owned HTTP sockets remain");
    assert.equal(dataHash(), initialHash);
  }
  console.log(JSON.stringify({
    coreAndPublicErrorIdentity: true, officialCodecIdentity: true, servedPublicQueryContract: true, nativeValues: true,
    cursorAndAuthScope: true, getManyOrderDuplicatesMissing: true, callerAfterDispatch: true, deadlineAfterDispatch: true,
    disconnect: true, reopen: true, retainedForeignLeases: true, noAdminOrOtherRoutes: true, noSecretCauses: true,
    dataUnchanged: true, cleanup: true, actualConvexBackend: false, actualHostedAuth: false,
  }));
}
main().catch(() => { console.error("Owned Convex packed consumer failed at phase: " + phase); process.exitCode = 1; });
