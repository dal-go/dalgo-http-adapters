// Runs inside the throwaway Git-subdirectory consumer. Imports every adapter
// through a dynamic import so the check proves the installed ESM entry points
// resolve, evaluate and share one @dalgo/core instance at runtime.
import assert from "node:assert/strict";

const [core, runtime, couchdb, postgrest] = await Promise.all([
  import("@dalgo/core"),
  import("@dalgo/adapter-runtime"),
  import("@dal-go/dalgo2couchdb"),
  import("@dal-go/dalgo2postgrest"),
]);

assert.equal(typeof core.collection, "function");
assert.equal(typeof core.key, "function");
assert.equal(typeof runtime.isCancellableQueryExecutor, "function");
assert.equal(typeof couchdb.CouchDbDatabase, "function");
assert.equal(typeof postgrest.PostgrestDatabase, "function");

const couch = new couchdb.CouchDbDatabase({ databaseUrl: "https://couch.example.test/app" });
const post = new postgrest.PostgrestDatabase({ baseUrl: "https://api.example.test/rest/v1" });

assert.equal(runtime.isCancellableQueryExecutor(couch), true);
assert.equal(runtime.isCancellableQueryExecutor(post), true);
assert.equal(typeof couch.queryWithSignal, "function");
assert.equal(typeof post.queryWithSignal, "function");
assert.equal(typeof couch.runReadwriteTransaction, "function");
assert.equal(typeof post.runReadwriteTransaction, "function");

console.log(JSON.stringify({
  core: { collection: typeof core.collection, key: typeof core.key },
  runtime: { isCancellableQueryExecutor: typeof runtime.isCancellableQueryExecutor },
  couch: {
    queryWithSignal: typeof couch.queryWithSignal,
    runReadwriteTransaction: typeof couch.runReadwriteTransaction,
  },
  postgrest: {
    queryWithSignal: typeof post.queryWithSignal,
    runReadwriteTransaction: typeof post.runReadwriteTransaction,
  },
}));
