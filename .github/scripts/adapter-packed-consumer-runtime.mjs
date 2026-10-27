import assert from "node:assert/strict";

import { UnsupportedError, key } from "@dalgo/core";
import { isCancellableQueryExecutor } from "@dalgo/adapter-runtime";
import { CouchDbDatabase, NativeCouchDbDatabase } from "@dal-go/dalgo2couchdb";
import { PostgrestDatabase } from "@dal-go/dalgo2postgrest";

const postgrest = new PostgrestDatabase({ baseUrl: "https://api.example.test/rest/v1" });
const couch = new CouchDbDatabase({ databaseUrl: "https://couch.example.test/app" });
const native = new NativeCouchDbDatabase({ databaseUrl: "https://couch.example.test/app", collection: "items" });

assert.equal(isCancellableQueryExecutor(postgrest), true);
assert.equal(isCancellableQueryExecutor(couch), true);
assert.equal(typeof postgrest.queryWithSignal, "function");
assert.equal(typeof couch.queryWithSignal, "function");
assert.equal(typeof postgrest.discover, "function");
assert.equal(typeof postgrest.testConnection, "function");
assert.equal(typeof postgrest.runReadwriteTransaction, "function");
assert.equal(typeof couch.runReadwriteTransaction, "function");
assert.equal(native.readOnly, true);
assert.equal(typeof native.queryWithSignal, "function");
assert.equal(typeof native.testConnection, "function");
assert.equal(typeof native.describe, "function");
await assert.rejects(native.insert(key("items", "milk"), { done: false }), UnsupportedError);
await assert.rejects(native.runReadwriteTransaction(() => Promise.resolve("no")), UnsupportedError);

console.log(JSON.stringify({
  postgrest: {
    queryWithSignal: typeof postgrest.queryWithSignal,
    discover: typeof postgrest.discover,
    testConnection: typeof postgrest.testConnection,
    runReadwriteTransaction: typeof postgrest.runReadwriteTransaction,
  },
  couch: {
    queryWithSignal: typeof couch.queryWithSignal,
    runReadwriteTransaction: typeof couch.runReadwriteTransaction,
  },
  native: {
    readOnly: native.readOnly,
    queryWithSignal: typeof native.queryWithSignal,
    testConnection: typeof native.testConnection,
    describe: typeof native.describe,
    insertRefused: true,
    transactionRefused: true,
  },
}));
