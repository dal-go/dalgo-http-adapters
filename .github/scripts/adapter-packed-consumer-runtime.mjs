import assert from "node:assert/strict";

import { isCancellableQueryExecutor } from "@dalgo/adapter-runtime";
import { CouchDbDatabase } from "@dal-go/dalgo2couchdb";
import { PostgrestDatabase } from "@dal-go/dalgo2postgrest";

const postgrest = new PostgrestDatabase({ baseUrl: "https://api.example.test/rest/v1" });
const couch = new CouchDbDatabase({ databaseUrl: "https://couch.example.test/app" });

assert.equal(isCancellableQueryExecutor(postgrest), true);
assert.equal(isCancellableQueryExecutor(couch), true);
assert.equal(typeof postgrest.queryWithSignal, "function");
assert.equal(typeof couch.queryWithSignal, "function");
assert.equal(typeof postgrest.discover, "function");
assert.equal(typeof postgrest.testConnection, "function");
assert.equal(typeof postgrest.runReadwriteTransaction, "function");
assert.equal(typeof couch.runReadwriteTransaction, "function");

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
}));
