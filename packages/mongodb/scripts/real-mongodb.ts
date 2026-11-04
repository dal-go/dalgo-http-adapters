import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BSON, MongoClient, type Document } from "mongodb";
import { collection, Key } from "@dalgo/core";

// The controller supplies pinned MongoDB bytes in this SAME capped Linux
// runtime. This fixture never pulls an image or starts a service on the host.
assert.equal(process.platform, "linux");
const memory = (await readFile("/sys/fs/cgroup/memory.max", "utf8")).trim();
const swap = (await readFile("/sys/fs/cgroup/memory.swap.max", "utf8")).trim();
const pids = (await readFile("/sys/fs/cgroup/pids.max", "utf8")).trim();
const [quota, period] = (await readFile("/sys/fs/cgroup/cpu.max", "utf8")).trim().split(/\s+/u);
assert(memory !== "max" && BigInt(memory) <= 2_147_483_648n);
assert.equal(swap, "0");
assert(pids !== "max" && BigInt(pids) <= 128n);
assert(quota !== undefined && period !== undefined && quota !== "max" && BigInt(period) > 0n && BigInt(quota) <= 2n * BigInt(period));
const binary = process.env.MONGO_SERVER_BINARY;
const source = process.env.MONGO_FIXTURE_SOURCE;
const binaryHash = process.env.MONGO_SERVER_SHA256;
const expectedVersion = process.env.MONGO_SERVER_VERSION;
const fixtureRoot = process.env.MONGO_FIXTURE_ROOT;
assert(typeof binary === "string" && binary.startsWith("/"), "controller must supply an absolute MONGO_SERVER_BINARY");
assert(source !== undefined && /^https:\/\/fastdl\.mongodb\.org\/linux\/mongodb-linux-x86_64-ubuntu2404-8\.0\.[0-9]+\.tgz@sha256:[0-9a-f]{64}$/u.test(source), "controller must pin official MONGO_FIXTURE_SOURCE archive URL and checksum");
assert(binaryHash !== undefined && /^[0-9a-f]{64}$/u.test(binaryHash), "controller must pin MONGO_SERVER_SHA256");
assert.equal(createHash("sha256").update(await readFile(binary)).digest("hex"), binaryHash);
assert(expectedVersion !== undefined && /^8\.0\.[0-9]+$/u.test(expectedVersion), "controller must pin exact MongoDB 8.0 patch version");
assert.equal(source.split("@sha256:")[0], `https://fastdl.mongodb.org/linux/mongodb-linux-x86_64-ubuntu2404-${expectedVersion}.tgz`);
assert(typeof fixtureRoot === "string" && fixtureRoot.startsWith("/"), "controller must supply an owned disk-backed MONGO_FIXTURE_ROOT");
const version = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 5000 }).split("\n")[0]?.trim();
assert.equal(version, `db version v${expectedVersion}`);
const port = Number(process.env.MONGO_FIXTURE_PORT ?? "17017");
assert(Number.isSafeInteger(port) && port > 1024 && port < 65_536);
const directory = await mkdtemp(join(fixtureRoot, "dalgo-mongodb-real-"));
const databaseName = `dalgo_fixture_${randomBytes(4).toString("hex")}`;
const adminPassword = randomBytes(24).toString("hex");
const readerPassword = randomBytes(24).toString("hex");
const local = `mongodb://127.0.0.1:${String(port)}`;
// Fixture operations are serialized. Admin, reader and invalid-auth principals
// retain separate clients; these pool limits do not change production defaults.
const clientOptions = { appName: "dalgo-mongo-owned-fixture", maxPoolSize: 1, maxConnecting: 1, serverSelectionTimeoutMS: 1000, connectTimeoutMS: 1000 };
const clients: MongoClient[] = [];
let child: ChildProcess | undefined;
let stopped = false;
const isStopped = (): boolean => stopped;
let browserFixture: typeof import("./real-browser.js") | undefined;
let preparedBrowser: import("./real-browser.js").PreparedMongoBrowser | undefined;

// Import the built package only after normal build has completed. The type-only
// source reference also allows a clean pre-build typecheck of this script.
const moduleUrl = new URL("../dist/node.js", import.meta.url).href;
const { MongoDatabase, MongoNodeExecutor, MongoHttpClient, createMongoHttpHandler } = await import(moduleUrl) as typeof import("../src/node.js");

function client(uri: string): MongoClient {
  const value = new MongoClient(uri, clientOptions);
  clients.push(value);
  return value;
}

async function failpoint(admin: MongoClient, milliseconds: number): Promise<number> {
  // enableTestCommands is enabled only on the owned ephemeral mongod below.
  // Its test-only APIs deliberately bypass auth in MongoDB 8.0.17; using this
  // fixture admin is a host ownership rule, not a provider privilege assertion.
  const configured = await admin.db("admin").command({ configureFailPoint: "failCommand", mode: { times: 1 }, data: {
    failCommands: ["find"], appName: clientOptions.appName, blockConnection: true, blockTimeMS: milliseconds,
  } });
  const count: unknown = configured.count;
  assert(typeof count === "number" && Number.isSafeInteger(count) && count >= 0);
  return count;
}

async function waitForBlockedFind(admin: MongoClient, count: number): Promise<void> {
  // This server-side counter proves the read entered the owned failpoint before
  // caller abort. A commandStarted event or elapsed timer alone is insufficient.
  await admin.db("admin").command({ waitForFailPoint: "failCommand", timesEntered: count + 1, maxTimeMS: 1000 });
}

function canonical(value: unknown): string { return JSON.stringify(BSON.EJSON.serialize(value, { relaxed: false })); }

try {
  if (process.env.MONGO_BROWSER_FIXTURE === "1") {
    const browserModuleUrl = new URL("./real-browser.ts", import.meta.url).href;
    browserFixture = await import(browserModuleUrl) as typeof import("./real-browser.js");
    preparedBrowser = await browserFixture.prepareMongoBrowser();
  }
  const spawned = spawn(binary, [
    "--bind_ip", "127.0.0.1", "--port", String(port), "--dbpath", directory,
    "--auth", "--wiredTigerCacheSizeGB", "0.25", "--setParameter", "enableTestCommands=1",
    "--setParameter", "diagnosticDataCollectionEnabled=false",
  ], { stdio: "ignore" });
  child = spawned;
  spawned.on("error", () => { stopped = true; });
  spawned.on("exit", () => { stopped = true; });
  await preparedBrowser?.sample("mongod-spawned-with-existing-browser");
  const bootstrap = client(`${local}/admin`);
  const startupDeadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < startupDeadline && !isStopped()) {
    try { await bootstrap.connect(); ready = true; break; } catch { await delay(50); }
  }
  assert(ready, "bounded MongoDB startup failed");
  await preparedBrowser?.sample("mongod-ready-with-existing-browser");
  // MongoDB's localhost exception permits only this initial synthetic admin.
  await bootstrap.db("admin").command({ createUser: "fixture_admin", pwd: adminPassword, roles: [{ role: "root", db: "admin" }] });
  await bootstrap.close();
  const admin = client(`mongodb://fixture_admin:${adminPassword}@127.0.0.1:${String(port)}/admin`);
  await admin.connect();
  const db = admin.db(databaseName);
  await db.command({ createUser: "fixture_reader", pwd: readerPassword, roles: [{ role: "read", db: databaseName }] });
  const firstId = new BSON.ObjectId("000000000000000000000001");
  const binaryValue = new Uint8Array([0, 255, 128, 13, 10]);
  await db.collection("existing_products").insertMany([
    { _id: firstId, active: true, count: BSON.Long.fromString("9007199254740993"), amount: BSON.Decimal128.fromString("12345678901234567890.001"), payload: new BSON.Binary(binaryValue), created: new Date("2300-01-01T00:00:00Z") },
    { _id: new BSON.ObjectId("000000000000000000000002"), active: false, count: BSON.Long.fromString("-9007199254740993") },
    { _id: new BSON.ObjectId("000000000000000000000003"), active: true, note: "existing native document" },
  ]);
  const mixed: Document[] = [
    { _id: BSON.Long.fromString("9007199254740993"), value: "integer" },
    { _id: "alpha", value: "string" },
    { _id: new BSON.ObjectId("100000000000000000000001"), value: "objectId" },
    { _id: new Date("2020-01-01T00:00:00Z"), value: "date" },
  ];
  await db.collection("mixed_identity").insertMany(mixed);
  const reader = client(`mongodb://fixture_reader:${readerPassword}@127.0.0.1:${String(port)}/${databaseName}`);
  await reader.connect();
  await preparedBrowser?.sample("separate-admin-and-reader-ready");
  const options = { database: reader.db(databaseName), collections: { products: "existing_products", mixed: "mixed_identity" }, maxRows: 10, maxPages: 10 };
  const executor = new MongoNodeExecutor(options);
  const core = new MongoDatabase(executor);
  assert.deepEqual(await executor.execute({ kind: "discover" }), { kind: "collections", source: "configured", collections: ["products", "mixed"] });
  const record = await core.get<Record<string, unknown>>(new Key("products", firstId.toHexString()));
  assert(record.exists);
  assert.deepEqual(record.data.count, { $numberLong: "9007199254740993" });
  assert.deepEqual(record.data.amount, { $numberDecimal: "12345678901234567890.001" });
  assert.deepEqual(record.data.payload, { $binary: { base64: Buffer.from(binaryValue).toString("base64"), subType: "00" } });
  assert.deepEqual(record.data.created, { $date: { $numberLong: String(new Date("2300-01-01T00:00:00Z").getTime()) } });
  assert.equal((await core.get(new Key("products", "ffffffffffffffffffffffff"))).exists, false);

  const nativeIds: string[] = [];
  let after: string | undefined;
  let pages = 0;
  do {
    assert(++pages <= 10, "fixture whole-query page cap reached");
    const page = await executor.execute({ kind: "find", collection: "mixed", limit: 1, ...(after === undefined ? {} : { after }) });
    assert.equal(page.kind, "documents");
    for (const row of page.documents) nativeIds.push(JSON.stringify(row._id));
    after = page.nextCursor;
  } while (after !== undefined);
  const expected = await db.collection("mixed_identity").find({}, { promoteValues: false, promoteLongs: false }).sort({ _id: 1 }).toArray();
  assert.deepEqual(nativeIds, expected.map((row) => canonical(row._id)));
  assert.equal(new Set(nativeIds).size, 4);
  const products = collection("products");
  const first = await core.query(products.query().where("active", "==", true).limit(1).build());
  assert.equal(first.records[0]?.key.id, firstId.toHexString());
  assert(first.nextCursor !== undefined);
  const second = await core.query(products.query().where("active", "==", true).limit(1).startAfter(...first.nextCursor.values).build());
  assert.equal(second.records[0]?.key.id, "000000000000000000000003");
  assert.equal(second.nextCursor, undefined);

  const aggregate = await executor.execute({ kind: "aggregate", collection: "products", pipeline: [{ $match: { active: true } }, { $sort: { _id: 1 } }], limit: 2 });
  assert.equal(aggregate.kind, "documents");
  assert.equal(aggregate.documents.length, 2);
  await assert.rejects(executor.execute({ kind: "aggregate", collection: "products", pipeline: [{ $out: "forbidden" }], limit: 2 }), { code: "unsupported" });
  await assert.rejects(executor.execute({ kind: "aggregate", collection: "products", pipeline: [], limit: 1 }), { code: "bounds" });
  await assert.rejects(executor.execute({ kind: "find", collection: "foreign", limit: 1 }), { code: "permission" });
  // Independently prove provider read-only grants, beyond the adapter's policy.
  await assert.rejects(reader.db(databaseName).collection("existing_products").insertOne({ _id: new BSON.ObjectId() }), { code: 13 });
  // createUser requires the real createUser action, absent from the read role.
  // Unlike the deliberately auth-free test APIs, this proves a provider boundary.
  await assert.rejects(reader.db(databaseName).command({ createUser: "forbidden_reader_created_user", pwd: randomBytes(24).toString("hex"), roles: [] }), { code: 13 });
  const bad = client(`mongodb://fixture_reader:wrong-password@127.0.0.1:${String(port)}/${databaseName}`);
  await assert.rejects(new MongoNodeExecutor({ ...options, database: bad.db(databaseName) }).execute({ kind: "find", collection: "products", limit: 1 }), { code: "authentication" });
  await assert.rejects(new MongoNodeExecutor({ ...options, maxResponseBytes: 32 }).execute({ kind: "find", collection: "products", limit: 1 }), { code: "bounds" });

  const page = await executor.execute({ kind: "find", collection: "products", limit: 1 });
  assert.equal(page.kind, "documents"); assert(page.nextCursor !== undefined);
  const forged = `${page.nextCursor.slice(0, -1)}${page.nextCursor.endsWith("a") ? "b" : "a"}`;
  await assert.rejects(executor.execute({ kind: "find", collection: "products", limit: 1, after: forged }), { code: "permission" });
  await assert.rejects(executor.execute({ kind: "find", collection: "products", filter: { active: true }, limit: 1, after: page.nextCursor }), { code: "protocol" });
  await assert.rejects(new MongoNodeExecutor({ ...options, maxPages: 1 }).execute({ kind: "find", collection: "products", limit: 1 }), { code: "bounds" });
  const expiring = new MongoNodeExecutor({ ...options, cursorTtlMs: 5 });
  const expires = await expiring.execute({ kind: "find", collection: "products", limit: 1 });
  assert.equal(expires.kind, "documents"); assert(expires.nextCursor !== undefined);
  await delay(10);
  await assert.rejects(expiring.execute({ kind: "find", collection: "products", limit: 1, after: expires.nextCursor }), { code: "protocol" });

  // Block only this owned synthetic instance. Server-side entry proves dispatch;
  // cancellation and reopen do not claim an independently observed remote kill.
  const callerCount = await failpoint(admin, 1000);
  const abort = new AbortController();
  const pending = executor.execute({ kind: "find", collection: "products", limit: 1 }, abort.signal);
  const callerRejection = assert.rejects(pending, { name: "QueryCancelledError", reason: "caller" });
  try { await waitForBlockedFind(admin, callerCount); }
  finally { abort.abort(); await callerRejection; }
  await delay(1100);
  await core.testConnection("products");
  const deadlineCount = await failpoint(admin, 1000);
  const deadlineRejection = assert.rejects(new MongoNodeExecutor({ ...options, timeoutMs: 500 }).execute({ kind: "find", collection: "products", limit: 1 }), { name: "QueryCancelledError", reason: "deadline" });
  try { await waitForBlockedFind(admin, deadlineCount); }
  finally { await deadlineRejection; }
  await delay(1100);
  await core.testConnection("products");

  const handler = createMongoHttpHandler({ authorize: (request, id) => Promise.resolve(request.headers.get("authorization") === "Bearer synthetic-user" && id === "owned" ? executor : undefined) });
  const http = new MongoHttpClient({ endpoint: "http://127.0.0.1/fixture/mongo", connectionId: "owned", headers: () => ({ authorization: "Bearer synthetic-user" }), fetch: (input, init) => handler(new Request(input, init)) });
  const browserCore = new MongoDatabase(http);
  assert.deepEqual((await browserCore.get(new Key("products", firstId.toHexString()))).data, record.data);
  await assert.rejects(new MongoHttpClient({ endpoint: "http://127.0.0.1/fixture/mongo", connectionId: "owned", fetch: (input, init) => handler(new Request(input, init)) }).execute({ kind: "discover" }), { code: "permission" });

  let browserProof: Readonly<Record<string, unknown>> | undefined;
  if (preparedBrowser !== undefined) {
    assert(browserFixture !== undefined);
    await preparedBrowser.sample("service-assertions-passed-with-existing-browser");
    browserProof = await browserFixture.runMongoBrowserFixture({
      executor, invalidAuthExecutor: new MongoNodeExecutor({ ...options, database: bad.db(databaseName) }), createHandler: createMongoHttpHandler,
      expectedId: firstId.toHexString(), expectedDocument: record.data,
      armBlockedRead: () => failpoint(admin, 1000), waitForBlockedRead: (count) => waitForBlockedFind(admin, count),
    }, preparedBrowser);
    // Parent owns browser cleanup on success and every failure path below.
    // The shared sample list includes the observed close before proof output.
    await preparedBrowser.close();
  }
  process.stdout.write(JSON.stringify({ ok: true, version, source, sourceKind: "binaryarchive", binaryHash, seededDocuments: 7, mixedBsonIdPages: pages, exactInt64DecimalBinaryDate: true, configuredMetadata: true, modernCoreQueryAndPage: true, leastPrivilege: true, badAuth: true, readOnlyPolicy: true, cursorBindingSignatureExpiryAndPageCap: true, serverObservedDispatchBeforeCancellation: true, localCallerCancelAndDeadline: true, remoteCancellationIndependentlyObserved: false, reopen: true, inProcessTrustedHttpToTypeScript: true, actualApplicationBrowser: false, ...(browserProof === undefined ? {} : { browserProof }) }) + "\n");
} finally {
  try { await preparedBrowser?.close(); }
  finally {
    if (preparedBrowser !== undefined) process.stdout.write(JSON.stringify({ mongoBrowserLifecycleResources: preparedBrowser.samples }) + "\n");
    await Promise.race([Promise.allSettled(clients.map((value) => value.close())), delay(2000)]);
    if (child !== undefined && !isStopped()) {
      const owned = child;
      const exited = new Promise<void>((resolve) => { owned.once("exit", () => { resolve(); }); });
      owned.kill("SIGTERM");
      await Promise.race([exited, delay(2000)]);
      if (!isStopped()) { owned.kill("SIGKILL"); await Promise.race([exited, delay(1000)]); }
      assert(isStopped(), "owned MongoDB child cleanup failed");
    }
    await rm(directory, { recursive: true, force: true });
  }
}
