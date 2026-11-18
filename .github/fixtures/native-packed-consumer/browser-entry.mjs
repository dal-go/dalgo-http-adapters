// Browser platform bundle entry. It has no Node test helpers or polyfills.
import * as core from "@dalgo/core";
import * as runtime from "@dalgo/adapter-runtime";
import * as redis from "@dalgo/dalgo2redis-resp";
import * as mongo from "@dalgo/dalgo2mongodb";
import * as mongoBrowser from "@dalgo/dalgo2mongodb/browser";
import * as duck from "@dalgo/dalgo2duckdb";
import * as duckBrowser from "@dalgo/dalgo2duckdb/browser";

function check(condition, message) { if (!condition) throw new Error(message); }
async function rejects(operation, ErrorType) {
  let rejected;
  try { await operation; } catch (error) { rejected = error; }
  check(rejected instanceof ErrorType, "browser bundle lost the shared public error identity");
}

export async function verifyBrowserRoots() {
  check(!("MongoNodeExecutor" in mongo), "Mongo root exposed its Node executor");
  check(!("RedisNodeExecutor" in redis), "Redis root exposed its Node executor");
  check(!("NodeDuckDBDatabase" in duck) && !("BrowserDuckDBDatabase" in duck), "Duck root exposed an engine entry");
  check(mongo.MongoDatabase === mongoBrowser.MongoDatabase && mongo.MongoHttpClient === mongoBrowser.MongoHttpClient, "Mongo browser alias changed");
  check(duck.DuckDBError === duckBrowser.DuckDBError, "Duck browser error identity changed");
  const database = new mongo.MongoDatabase(new mongo.MongoHttpClient({ endpoint: "/mongo", connectionId: "fixture" }), { idKind: "string" });
  let callbackRan = false;
  await rejects(database.runReadwriteTransaction(async () => { callbackRan = true; }), core.UnsupportedError);
  check(!callbackRan, "unsupported browser transaction executed a callback");
  new redis.RedisHttpExecutor({ endpoint: "https://app.example.test/redis" });
  const ordinal = new duckBrowser.BrowserDuckDBDatabase({ bundle: { mainModule: "/engine.wasm", mainWorker: "/worker.js" } });
  check(runtime.isOrdinalQueryExecutor(ordinal) && ordinal.readOnly === true, "Duck browser ordinal contract changed");
  const controller = new AbortController(); controller.abort();
  await rejects(ordinal.queryOrdinal({ kind: "native", sql: "SELECT 1" }, controller.signal), runtime.QueryCancelledError);
  return { coreIdentity: true, duckLazyRootAndBrowser: true };
}
