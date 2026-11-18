// Owned account-free HTTP protocol fixture for the ACTUAL packed public client.
// This is not an Upstash service or Redis-server/CORS/browser qualification.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { QueryCancelledError } from "@dalgo/adapter-runtime";
import { RedisReadError as ProtocolError, scopeRedisRead } from "@dalgo/dalgo2redis-resp/protocol";
import { RedisReadError, UpstashRedisExecutor } from "@dalgo/dalgo2upstash-redis";

const token = "owned-fixture-acl-read-token";
const sockets = new Set();
const socketCloseAcknowledgements = [];
let closing = false;
let requests = 0;
let observed;
let responseClosed;
function bulk(value) { const bytes = Buffer.from(value); return Buffer.concat([Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from("\r\n")]); }
function array(values) { return Buffer.concat([Buffer.from(`*${values.length}\r\n`), ...values]); }
async function bounded(promise, milliseconds = 2500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("owned HTTP fixture deadline")), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
const server = createServer((request, response) => {
  void (async () => {
    requests++;
    assert.equal(request.method, "POST"); assert.equal(request.url, "/");
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers["upstash-response-format"], "resp2");
    assert.equal(request.headers["upstash-encoding"], undefined);
    assert.equal(request.headers.cookie, undefined);
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; assert.ok(size <= 4096); chunks.push(chunk); }
    const command = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.ok(Array.isArray(command) && command.every(value => typeof value === "string"));
    if (command[0] === "GET" && command[1] === "slow") {
      response.once("close", () => responseClosed?.());
      observed?.();
      return; // Wait for exact owned HTTP abort; never return invented data.
    }
    let body;
    if (command[0] === "GET") body = bulk(Buffer.from([0, 255, 128]));
    else if (command[0] === "HLEN") body = Buffer.from(":9223372036854775807\r\n");
    else if (command[0] === "TYPE") body = Buffer.from("+string\r\n");
    else if (command[0] === "MGET" && command[1] === "malformed") body = array([bulk("partial")]);
    else if (command[0] === "MGET") body = array([bulk("x"), Buffer.from("$-1\r\n")]);
    else if (command[0] === "SCAN") {
      assert.deepEqual(command, scopeRedisRead(["SCAN", "0", "COUNT", "1"], "fixture:"));
      body = array([bulk("7"), array([bulk("fixture:k"), bulk("fixture:k")])]);
    } else throw new Error("unexpected fixture command");
    response.writeHead(200, { "content-type": "application/octet-stream" }); response.end(body);
  })().catch(() => { response.writeHead(401, { "content-type": "text/plain" }); response.end("owned-secret-service-error"); });
});
server.on("connection", socket => {
  sockets.add(socket);
  // Register positive completion before any destroy, including shutdown races.
  // A socket closed earlier in the test already has a resolved acknowledgement.
  socketCloseAcknowledgements.push(new Promise(resolve => {
    socket.once("close", () => { sockets.delete(socket); resolve(); });
  }));
  socket.on("error", () => undefined);
  if (closing) socket.destroy();
});
await bounded(new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }));
try {
  const address = server.address(); assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const db = new UpstashRedisExecutor({ endpoint, token, scanPrefix: "fixture:", allowInsecureLoopbackHttp: true, timeoutMs: 500 });
  assert.equal(RedisReadError, ProtocolError, "one shared native protocol error identity");
  assert.equal(db.readOnly, true);
  assert.deepEqual(await db.execute(["GET", "binary"]), { kind: "bytes", base64: "AP+A" });
  assert.deepEqual(await db.execute(["HLEN", "hash"]), { kind: "integer", value: "9223372036854775807" });
  assert.equal(await db.execute(["TYPE", "binary"]), "string");
  assert.deepEqual(await db.execute(["MGET", "a", "missing"]), { kind: "array", values: [{ kind: "bytes", base64: "eA==" }, null] });
  await assert.rejects(db.execute(["MGET", "malformed", "b"]), error => error instanceof RedisReadError && error.code === "protocol");
  assert.deepEqual(await db.execute(["SCAN", "0", "COUNT", "1"]), { kind: "array", values: [{ kind: "bytes", base64: "Nw==" }, { kind: "array", values: [{ kind: "bytes", base64: "Zml4dHVyZTpr" }, { kind: "bytes", base64: "Zml4dHVyZTpr" }] }] });
  const before = requests;
  await assert.rejects(db.execute(["SET", "key", "value"]), RedisReadError);
  await assert.rejects(db.execute(["SCAN", "0", "MATCH", "*"]), RedisReadError);
  assert.equal(requests, before, "policy refusal must not dispatch or acquire privilege");
  const bad = new UpstashRedisExecutor({ endpoint, token: "wrong-fixture-token", allowInsecureLoopbackHttp: true });
  await assert.rejects(bad.execute(["GET", "key"]), error => error instanceof RedisReadError && error.code === "denied" && !/secret|token|127\.0\.0\.1/u.test(error.message));
  for (const deadline of [false, true]) {
    const caller = new AbortController();
    const dispatched = new Promise(resolve => { observed = resolve; });
    const closed = new Promise(resolve => { responseClosed = resolve; });
    const work = db.execute(["GET", "slow"], caller.signal);
    // Attach a rejection observer before the real finite deadline can fire.
    const rejected = assert.rejects(work, error => error instanceof QueryCancelledError && error.reason === (deadline ? "deadline" : "caller") && !error.message.includes("owned-secret-caller-cause"));
    await bounded(dispatched);
    if (!deadline) caller.abort(new Error("owned-secret-caller-cause"));
    await bounded(rejected); await bounded(closed);
    assert.deepEqual(await db.execute(["GET", "reopened"]), { kind: "bytes", base64: "AP+A" });
  }
} finally {
  observed = undefined; responseClosed = undefined;
  closing = true;
  // Stop accepting before destroying connections. A late accepted connection
  // registers its own acknowledgement above and is immediately destroyed.
  const serverClosed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const completed = bounded((async () => {
    await serverClosed;
    // Server close can precede the socket close registry callbacks. Accepts are
    // now stopped, so wait for every owned socket's actual close event as well.
    await Promise.all(socketCloseAcknowledgements);
  })());
  for (const socket of sockets) socket.destroy();
  server.closeAllConnections(); server.closeIdleConnections();
  await completed;
  assert.equal(sockets.size, 0, "owned HTTP fixture sockets remain");
}
console.log(JSON.stringify({ publicErrorIdentity: true, servedHttpContract: true, nativeValues: true, malformedRepliesRefused: true, scopedScan: true, badAuthRedacted: true, readOnly: true, callerAfterDispatch: true, deadlineAfterDispatch: true, reopen: true, cleanup: true, hostedUpstash: false }));
