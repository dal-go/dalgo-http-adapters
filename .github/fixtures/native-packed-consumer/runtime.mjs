// Public packed entry points only. No service connections or DuckDB engine loads.
import assert from "node:assert/strict";

const [core, runtime, redis, mongo, mongoBrowser, duck, redisNode, mongoNode, duckNode, duckBrowser] = await Promise.all([
  import("@dalgo/core"), import("@dalgo/adapter-runtime"), import("@dalgo/dalgo2redis-resp"),
  import("@dalgo/dalgo2mongodb"), import("@dalgo/dalgo2mongodb/browser"), import("@dalgo/dalgo2duckdb"),
  import("@dalgo/dalgo2redis-resp/node"), import("@dalgo/dalgo2mongodb/node"),
  import("@dalgo/dalgo2duckdb/node"), import("@dalgo/dalgo2duckdb/browser"),
]);
assert.equal(typeof core.collection, "function");
assert.equal(typeof core.key, "function");
assert.equal(typeof runtime.isCancellableQueryExecutor, "function");
assert.equal(typeof runtime.isOrdinalQueryExecutor, "function");
assert.equal(mongo.MongoDatabase, mongoBrowser.MongoDatabase);
assert.equal(mongo.MongoHttpClient, mongoBrowser.MongoHttpClient);
assert.equal("MongoNodeExecutor" in mongo, false);
assert.equal("RedisNodeExecutor" in redis, false);
assert.equal("NodeDuckDBDatabase" in duck, false);
assert.equal("BrowserDuckDBDatabase" in duck, false);
assert.equal(duck.DuckDBError, duckNode.DuckDBError);
assert.equal(duck.DuckDBError, duckBrowser.DuckDBError);
assert.equal(typeof mongoNode.MongoNodeExecutor, "function");
assert.equal(typeof mongoNode.createMongoHttpHandler, "function");
assert.equal(typeof redisNode.createRedisHttpHandler, "function");

const http = new mongo.MongoHttpClient({ endpoint: "https://app.example.test/mongo", connectionId: "fixture" });
const database = new mongo.MongoDatabase(http, { idKind: "string" });
let callbackRan = false;
await assert.rejects(database.runReadwriteTransaction(async () => { callbackRan = true; }), core.UnsupportedError);
assert.equal(callbackRan, false, "unsupported transactions must not execute a callback");

const controller = new AbortController();
controller.abort("synthetic-reason");
const ordinal = new duckNode.NodeDuckDBDatabase();
assert.equal(runtime.isOrdinalQueryExecutor(ordinal), true);
assert.equal(ordinal.readOnly, true);
await assert.rejects(ordinal.queryOrdinal({ kind: "native", sql: "SELECT 1" }, controller.signal), error => error instanceof runtime.QueryCancelledError && error.reason === "caller" && !error.message.includes("synthetic-reason"));
const resp = new redisNode.RedisNodeExecutor({ host: "127.0.0.1", port: 1 });
await assert.rejects(resp.execute(["GET", "fixture"], controller.signal), runtime.QueryCancelledError);

console.log(JSON.stringify({
  core: { sharedUnsupportedError: true },
  runtime: { sharedCancellationError: true, ordinal: true },
  redisResp: { node: typeof redisNode.RedisNodeExecutor, http: typeof redis.RedisHttpExecutor },
  mongodb: { node: typeof mongoNode.MongoNodeExecutor, database: typeof mongo.MongoDatabase, browserAlias: true },
  duckdb: { rootEngineFree: true, node: typeof duckNode.NodeDuckDBDatabase, browser: typeof duckBrowser.BrowserDuckDBDatabase, preAbortEngineFree: true },
}));
