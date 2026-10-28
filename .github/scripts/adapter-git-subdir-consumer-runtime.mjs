// Runs inside the throwaway Git-subdirectory consumer. Imports every adapter
// through a dynamic import so the check proves the installed ESM entry points
// resolve, evaluate and share one @dalgo/core instance at runtime.
import assert from "node:assert/strict";

const [core, runtime, couchdb, postgrest, libs] = await Promise.all([
  import("@dalgo/core"),
  import("@dalgo/adapter-runtime"),
  import("@dal-go/dalgo2couchdb"),
  import("@dal-go/dalgo2postgrest"),
  import("@dal-go/dalgo2libsql"),
]);

assert.equal(typeof core.collection, "function");
assert.equal(typeof core.key, "function");
assert.equal(typeof runtime.isCancellableQueryExecutor, "function");
assert.equal(typeof couchdb.CouchDbDatabase, "function");
assert.equal(typeof postgrest.PostgrestDatabase, "function");
assert.equal(typeof libs.LibSQLDatabase, "function");
assert.equal(typeof libs.NativeLibSQLDatabase, "function");

const couch = new couchdb.CouchDbDatabase({ databaseUrl: "https://couch.example.test/app" });
const post = new postgrest.PostgrestDatabase({ baseUrl: "https://api.example.test/rest/v1" });
const managed = new libs.LibSQLDatabase({
  serverUrl: "https://libsql.example.test",
  tables: { items: { table: "items", keyColumn: { column: "id" }, columns: { title: { column: "title" } } } },
});
const native = new libs.NativeLibSQLDatabase({
  serverUrl: "https://libsql.example.test",
  tables: { items: { table: "items", uniqueKey: true, key: { column: "id", type: "integer" }, columns: { title: { column: "title", nullable: false } } } },
});

assert.equal(runtime.isCancellableQueryExecutor(couch), true);
assert.equal(runtime.isCancellableQueryExecutor(post), true);
assert.equal(runtime.isCancellableQueryExecutor(managed), true);
assert.equal(runtime.isCancellableQueryExecutor(native), true);
assert.equal(typeof couch.queryWithSignal, "function");
assert.equal(typeof post.queryWithSignal, "function");
assert.equal(typeof couch.runReadwriteTransaction, "function");
assert.equal(typeof post.runReadwriteTransaction, "function");
assert.equal(typeof managed.queryWithSignal, "function");
assert.equal(typeof native.queryWithSignal, "function");
assert.equal(typeof managed.discover, "function");
assert.equal(typeof native.discover, "function");
assert.equal(typeof native.testConnection, "function");
assert.equal(typeof native.describe, "function");
assert.equal(native.readOnly, true);

const insertRefused = await native.insert(new core.Key("items", 1), {}).then(() => false, (error) => error?.name === "UnsupportedError");
const transactionRefused = await native.runReadwriteTransaction(async () => "x").then(() => false, (error) => error?.name === "UnsupportedError");
assert.equal(insertRefused, true);
assert.equal(transactionRefused, true);

console.log(JSON.stringify({
  core: { collection: typeof core.collection, key: typeof core.key },
  runtime: { isCancellableQueryExecutor: typeof runtime.isCancellableQueryExecutor },
  couch: {
    queryWithSignal: typeof couch.queryWithSignal,
    runReadwriteTransaction: typeof couch.runReadwriteTransaction,
  },
  postgrest: {
    queryWithSignal: typeof post.queryWithSignal,
    discover: typeof post.discover,
    testConnection: typeof post.testConnection,
    runReadwriteTransaction: typeof post.runReadwriteTransaction,
  },
  libsql: {
    queryWithSignal: typeof managed.queryWithSignal,
    discover: typeof managed.discover,
    testConnection: typeof managed.testConnection,
    managedQueryWithSignal: typeof managed.queryWithSignal,
  },
  nativeLibsql: {
    readOnly: native.readOnly,
    queryWithSignal: typeof native.queryWithSignal,
    discover: typeof native.discover,
    testConnection: typeof native.testConnection,
    describe: typeof native.describe,
    insertRefused,
    transactionRefused,
  },
}));
