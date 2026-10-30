// Runs inside the throwaway packed consumer. Imports every adapter through a
// dynamic import so the check proves the installed ESM entry points resolve,
// evaluate and share one @dalgo/core instance at runtime.
import assert from "node:assert/strict";

const [core, runtime, couchdb, postgrest, libsql, typesense] = await Promise.all([
  import("@dalgo/core"),
  import("@dalgo/adapter-runtime"),
  import("@dalgo/dalgo2couchdb"),
  import("@dalgo/dalgo2postgrest"),
  import("@dalgo/dalgo2libsql"),
  import("@dalgo/dalgo2typesense"),
]);

assert.equal(typeof core.collection, "function");
assert.equal(typeof core.key, "function");
assert.equal(typeof runtime.isCancellableQueryExecutor, "function");
assert.equal(typeof couchdb.CouchDbDatabase, "function");
assert.equal(typeof couchdb.NativeCouchDbDatabase, "function");
assert.equal(typeof postgrest.PostgrestDatabase, "function");
assert.equal(typeof libsql.LibSQLDatabase, "function");
assert.equal(typeof libsql.NativeLibSQLDatabase, "function");
assert.equal(typeof typesense.TypesenseDatabase, "function");
assert.equal(typeof typesense.decodeSearchResponse, "function");

const couch = new couchdb.CouchDbDatabase({ databaseUrl: "https://couch.example.test/app" });
const nativeCouch = new couchdb.NativeCouchDbDatabase({ databaseUrl: "https://couch.example.test/app", collection: "items" });
const post = new postgrest.PostgrestDatabase({ baseUrl: "https://api.example.test/rest/v1" });
const managed = new libsql.LibSQLDatabase({
  serverUrl: "https://libsql.example.test",
  tables: { items: { table: "items", keyColumn: { column: "id" }, columns: { title: { column: "title" } } } },
});
const nativeLibsql = new libsql.NativeLibSQLDatabase({
  serverUrl: "https://libsql.example.test",
  tables: { items: { table: "items", uniqueKey: true, key: { column: "id", type: "integer" }, columns: { title: { column: "title", nullable: false } } } },
});

assert.equal(runtime.isCancellableQueryExecutor(couch), true);
assert.equal(runtime.isCancellableQueryExecutor(post), true);
assert.equal(runtime.isCancellableQueryExecutor(managed), true);
assert.equal(runtime.isCancellableQueryExecutor(nativeLibsql), true);
assert.equal(typeof couch.queryWithSignal, "function");
assert.equal(typeof post.queryWithSignal, "function");
assert.equal(typeof managed.queryWithSignal, "function");
assert.equal(typeof nativeLibsql.queryWithSignal, "function");
assert.equal(typeof post.discover, "function");
assert.equal(typeof post.testConnection, "function");
assert.equal(typeof post.runReadwriteTransaction, "function");
assert.equal(typeof couch.runReadwriteTransaction, "function");
assert.equal(typeof managed.discover, "function");
assert.equal(typeof nativeLibsql.discover, "function");
assert.equal(typeof nativeLibsql.testConnection, "function");
assert.equal(typeof nativeLibsql.describe, "function");
assert.equal(nativeCouch.readOnly, true);
assert.equal(typeof nativeCouch.queryWithSignal, "function");
assert.equal(typeof nativeCouch.testConnection, "function");
assert.equal(typeof nativeCouch.describe, "function");
assert.equal(nativeLibsql.readOnly, true);
await assert.rejects(nativeCouch.insert(core.key("items", "milk"), { done: false }), core.UnsupportedError);
await assert.rejects(nativeCouch.runReadwriteTransaction(async () => "no"), core.UnsupportedError);

const insertRefused = await nativeLibsql.insert(new core.Key("items", 1), {}).then(() => false, (error) => error?.name === "UnsupportedError");
const transactionRefused = await nativeLibsql.runReadwriteTransaction(async () => "x").then(() => false, (error) => error?.name === "UnsupportedError");
assert.equal(insertRefused, true);
assert.equal(transactionRefused, true);

const typesenseDb = new typesense.TypesenseDatabase({
  baseUrl: "https://typesense.example.test:8108",
  collection: "items",
  headers: () => ({ "X-TYPESENSE-API-KEY": "scoped-readonly-key" }),
});
const typesenseTransactionRefused = await typesenseDb.runReadwriteTransaction(async () => "x").then(() => false, (error) => error?.name === "UnsupportedError");
assert.equal(typesenseDb.readOnly, true);
assert.equal(runtime.isCancellableQueryExecutor(typesenseDb), true);
assert.equal(typeof typesenseDb.queryWithSignal, "function");
assert.equal(typeof typesenseDb.search, "function");
assert.equal(typeof typesenseDb.schema, "function");
assert.equal(typeof typesenseDb.describe, "function");
assert.equal(typesenseTransactionRefused, true);
const typesenseDecoded = typesense.decodeSearchResponse(
  { found: 1, out_of: 1, hits: [{ document: { id: "x" }, text_match: 1 }] },
  { limit: 1, offset: 0, facetFields: [], maxFacetValues: 0, maxRowBytes: 1024 },
);
assert.equal(typeof typesenseDecoded.hits[0].textMatch, "string");

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
    readOnly: nativeLibsql.readOnly,
    queryWithSignal: typeof nativeLibsql.queryWithSignal,
    discover: typeof nativeLibsql.discover,
    testConnection: typeof nativeLibsql.testConnection,
    describe: typeof nativeLibsql.describe,
    insertRefused,
    transactionRefused,
  },
  native: {
    readOnly: nativeCouch.readOnly,
    queryWithSignal: typeof nativeCouch.queryWithSignal,
    testConnection: typeof nativeCouch.testConnection,
    describe: typeof nativeCouch.describe,
    insertRefused: true,
    transactionRefused: true,
  },
  typesense: {
    readOnly: typesenseDb.readOnly,
    queryWithSignal: typeof typesenseDb.queryWithSignal,
    search: typeof typesenseDb.search,
    schema: typeof typesenseDb.schema,
    describe: typeof typesenseDb.describe,
    textMatch: typeof typesenseDecoded.hits[0].textMatch,
    transactionRefused: typesenseTransactionRefused,
  },
}));
