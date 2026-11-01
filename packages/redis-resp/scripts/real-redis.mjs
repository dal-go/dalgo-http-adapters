import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RedisNodeExecutor, createRedisHttpHandler } from "../dist/node.js";
import { RedisHttpExecutor } from "../dist/index.js";
import { parseRedisReply } from "../dist/resp.js";

// The controller supplies pinned Redis bytes inside the SAME capped Node container.
// This script never pulls images or starts a host service.
assert.equal(process.platform, "linux");
const limits = await Promise.all(["memory.max", "memory.swap.max", "pids.max"].map(name => readFile(`/sys/fs/cgroup/${name}`, "utf8")));
assert(BigInt(limits[0].trim()) <= 2_147_483_648n);
assert.equal(limits[1].trim(), "0");
assert(BigInt(limits[2].trim()) <= 128n);
const binary = process.env.REDIS_SERVER_BINARY;
const image = process.env.REDIS_FIXTURE_IMAGE;
assert(binary && binary.startsWith("/"), "controller must supply REDIS_SERVER_BINARY");
assert(image && /@sha256:[0-9a-f]{64}$/u.test(image), "controller must pin Redis image digest");
const version = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 5_000 }).trim();
assert(version.startsWith("Redis server v="));
const port = Number(process.env.REDIS_FIXTURE_PORT ?? "16379");
assert(Number.isSafeInteger(port) && port > 1_024 && port < 65_536);
const directory = await mkdtemp(join(tmpdir(), "dalgo-redis-real-"));
const adminPassword = randomBytes(24).toString("hex");
const readerPassword = randomBytes(24).toString("hex");
const config = join(directory, "redis.conf");
const adminSockets = new Set();
let child;
let stopped = false;

function encode(command) {
  const parts = [Buffer.from(`*${command.length}\r\n`)];
  for (const argument of command) {
    const bytes = Buffer.isBuffer(argument) ? argument : Buffer.from(argument);
    parts.push(Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from("\r\n"));
  }
  return Buffer.concat(parts);
}

// Fixture administration only. Production entry points never admit these writes/ACL operations.
function admin(command) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    adminSockets.add(socket);
    let bytes = Buffer.alloc(0);
    const replies = [];
    const finish = (error, value) => {
      socket.destroy();
      adminSockets.delete(socket);
      if (error) reject(new Error("Redis fixture administration failed"));
      else resolve(value);
    };
    socket.setTimeout(2_000, () => finish(true));
    socket.once("error", () => finish(true));
    socket.once("connect", () => socket.write(Buffer.concat([encode(["AUTH", adminPassword]), encode(command)])));
    socket.on("data", chunk => {
      if (bytes.length + chunk.length > 4_194_304) { finish(true); return; }
      bytes = Buffer.concat([bytes, chunk]);
      try {
        for (;;) {
          const parsed = parseRedisReply(bytes, 4_194_304);
          if (parsed === undefined) return;
          replies.push(parsed.value);
          bytes = bytes.subarray(parsed.offset);
          if (replies.length === 2) { finish(false, parsed.value); return; }
        }
      } catch { finish(true); }
    });
  });
}

function bulk(value) {
  assert.equal(value?.kind, "bytes");
  return Buffer.from(value.base64, "base64");
}

try {
  await writeFile(config, [
    "bind 127.0.0.1", `port ${port}`, "protected-mode yes", "daemonize no",
    'save ""', "appendonly no", `dir ${directory}`, "maxmemory 64mb", "maxmemory-policy noeviction",
    `user default on >${adminPassword} ~* &* +@all`,
  ].join("\n") + "\n", { mode: 0o600 });
  child = spawn(binary, [config], { stdio: "ignore" });
  child.on("error", () => { stopped = true; });
  child.on("exit", () => { stopped = true; });
  let ready = false;
  for (let attempt = 0; attempt < 100 && !stopped; attempt++) {
    try { await admin(["PING"]); ready = true; break; } catch { await delay(50); }
  }
  assert(ready, "bounded Redis startup failed");

  const exact = "9223372036854775807";
  const binaryValue = Buffer.from([0, 255, 128, 13, 10]);
  await admin(["SET", "fixture:integer", exact]);
  await admin(["SET", "fixture:binary", binaryValue]);
  await admin(["HSET", "fixture:hash", "name", "Ada", "count", exact]);
  await admin(["SET", "fixture:expiry", "x"]);
  await admin(["PEXPIREAT", "fixture:expiry", exact]);
  await admin(["SET", "foreign:secret", "not authorized"]);
  const binaryScanKey = Buffer.concat([Buffer.from("fixture:page:"), Buffer.from([0, 255, 128])]);
  for (let index = 0; index < 30; index++) await admin(["SET", index === 0 ? binaryScanKey : `fixture:page:${index}`, String(index)]);
  await admin(["ACL", "SETUSER", "dalgo_reader", "on", `>${readerPassword}`, "resetkeys", "~fixture:*", "resetchannels", "-@all",
    "+get", "+mget", "+hget", "+hmget", "+hexists", "+exists", "+type", "+ttl", "+pttl", "+strlen", "+hlen", "+llen", "+scard", "+zcard", "+zscore", "+scan"]);

  const options = { host: "127.0.0.1", port, username: "dalgo_reader", password: readerPassword, scanPrefix: "fixture:" };
  const redis = new RedisNodeExecutor(options);
  assert.deepEqual(bulk(await redis.execute(["GET", "fixture:binary"])), binaryValue);
  assert.equal(bulk(await redis.execute(["GET", "fixture:integer"])).toString(), exact);
  assert.equal(await redis.execute(["GET", "fixture:missing"]), null);
  assert.equal(bulk(await redis.execute(["HGET", "fixture:hash", "name"])).toString(), "Ada");
  const ttl = await redis.execute(["PTTL", "fixture:expiry"]);
  assert.equal(ttl.kind, "integer");
  assert(BigInt(ttl.value) > 9_007_199_254_740_991n && BigInt(ttl.value) < BigInt(exact));
  await assert.rejects(redis.execute(["GET", "foreign:secret"]), { code: "denied" });
  await assert.rejects(new RedisNodeExecutor({ ...options, password: "incorrect" }).execute(["GET", "fixture:integer"]), { code: "denied" });
  await assert.rejects(redis.execute(["SET", "fixture:integer", "mutated"]), { code: "policy" });
  await assert.rejects(redis.execute(["KEYS", "*"]), { code: "policy" });
  await assert.rejects(redis.execute(["SCAN", "0", "MATCH", "*"]), { code: "policy" });
  await assert.rejects(new RedisNodeExecutor({ host: "127.0.0.1", port, username: "dalgo_reader", password: readerPassword }).execute(["SCAN", "0"]), { code: "policy" });
  const keys = new Set();
  let cursor = "0";
  let pages = 0;
  do {
    assert(++pages <= 100, "fixture whole-scan work cap reached");
    const page = await redis.execute(["SCAN", cursor, "COUNT", "5"]);
    assert.equal(page.kind, "array");
    assert.equal(page.values.length, 2);
    cursor = bulk(page.values[0]).toString();
    const list = page.values[1];
    assert.equal(list.kind, "array");
    for (const key of list.values) {
      const bytes = bulk(key);
      assert(bytes.subarray(0, 8).equals(Buffer.from("fixture:")));
      keys.add(bytes.toString("base64"));
    }
  } while (cursor !== "0");
  assert.equal(keys.size, 34);
  assert(keys.has(binaryScanKey.toString("base64")));
  assert(!keys.has(Buffer.from("foreign:secret").toString("base64")));

  // Pause only the owned synthetic fixture, then observe real in-flight transport cancellation and reopen.
  await admin(["CLIENT", "PAUSE", "100", "ALL"]);
  const abort = new AbortController();
  const pending = redis.execute(["GET", "fixture:integer"], abort.signal);
  const cancel = setTimeout(() => abort.abort(), 10);
  try { await assert.rejects(pending, { name: "QueryCancelledError", reason: "caller" }); }
  finally { clearTimeout(cancel); }
  await delay(120);
  await admin(["CLIENT", "PAUSE", "100", "ALL"]);
  await assert.rejects(new RedisNodeExecutor({ ...options, timeoutMs: 10 }).execute(["GET", "fixture:integer"]), { name: "QueryCancelledError", reason: "deadline" });
  await delay(120);
  assert.equal(bulk(await redis.execute(["GET", "fixture:integer"])).toString(), exact);

  let authorized = false;
  const handle = createRedisHttpHandler({ authorize: request => Promise.resolve(request.headers.get("authorization") === "Bearer fixture-user" ? (authorized = true, redis) : undefined) });
  const http = new RedisHttpExecutor({ endpoint: "http://127.0.0.1/fixture", headers: () => Promise.resolve({ authorization: "Bearer fixture-user" }), fetch: (input, init) => handle(new Request(input, init)) });
  assert.deepEqual(bulk(await http.execute(["GET", "fixture:binary"])), binaryValue);
  assert(authorized);
  await assert.rejects(new RedisHttpExecutor({ endpoint: "http://127.0.0.1/fixture", fetch: (input, init) => handle(new Request(input, init)) }).execute(["GET", "fixture:integer"]), { code: "denied" });

  process.stdout.write(JSON.stringify({ ok: true, version, image, seededKeys: 35, scanPages: pages, scopedKeys: keys.size, binary: true, exactIntegerText: true, integerAboveSafeNumber: true, leastPrivilege: true, badAuth: true, readOnlyPolicy: true, scanScope: true, callerCancelAndDeadline: true, reopen: true, trustedHttpToTypeScript: true, actualApplicationBrowser: false }) + "\n");
} finally {
  for (const socket of adminSockets) socket.destroy();
  if (child !== undefined && !stopped) {
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, delay(2_000)]);
    if (!stopped) { child.kill("SIGKILL"); await Promise.race([exited, delay(1_000)]); }
    assert(stopped, "owned Redis child cleanup failed");
  }
  await rm(directory, { recursive: true, force: true });
}
