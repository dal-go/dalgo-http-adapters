import {
  COUCHDB_READ_CAPABILITIES,
  CouchDbDatabase,
  CouchDbRequestError,
  NATIVE_COUCHDB_READ_CAPABILITIES,
  NativeCouchDbDatabase,
  type CouchDbDatabaseOptions,
  type NativeCouchDbConnectionTest,
  type NativeCouchDbDatabaseOptions,
  type NativeCouchDbDescribe,
  type NativeCouchDbQuery,
} from "@dal-go/dalgo2couchdb";
import {
  POSTGREST_READ_CAPABILITIES,
  PostgrestDatabase,
  PostgrestRequestError,
  type PostgrestDatabaseOptions,
} from "@dal-go/dalgo2postgrest";
import {
  isCancellableQueryExecutor,
  type CancellableQueryExecutor,
} from "@dalgo/adapter-runtime";
import {
  collection,
  key,
  type Database,
  type QueryPage,
  type ReadwriteTransaction,
  type StructuredQuery,
  type WriteSession,
} from "@dalgo/core";

declare const signal: AbortSignal;

const postgrestOptions: PostgrestDatabaseOptions = {
  baseUrl: "https://api.example.test/rest/v1",
  maxQueryLimit: 10,
};
const couchOptions: CouchDbDatabaseOptions = {
  databaseUrl: "https://couch.example.test/app",
  maxQueryLimit: 10,
};
const nativeOptions: NativeCouchDbDatabaseOptions = {
  databaseUrl: "https://couch.example.test/app",
  collection: "items",
  maxQueryLimit: 10,
  permittedIndexes: [{
    ddoc: "_design/status-id",
    name: "status-id-index",
    fields: [
      { field: "status", direction: "asc" },
      { field: "_id", direction: "asc" },
    ],
  }],
};
const postgrest = new PostgrestDatabase(postgrestOptions);
const couch = new CouchDbDatabase(couchOptions);
const nativeCouch = new NativeCouchDbDatabase(nativeOptions);

// The managed adapters still satisfy the core Database/WriteSession identity.
const postgrestDatabase: Database & WriteSession = postgrest;
const couchDatabase: Database & WriteSession = couch;
const nativeDatabase: Database = nativeCouch;
const nativeStorage: "native-rows" = NATIVE_COUCHDB_READ_CAPABILITIES.storage;

// The additive cancellable surface is assignable to the shared runtime contract.
const postgrestCancellable: CancellableQueryExecutor = postgrest;
const couchCancellable: CancellableQueryExecutor = couch;

const items = collection<{ done: boolean }>("items");
const query: StructuredQuery<{ done: boolean }> = items.query().limit(1).build();
const postPage: Promise<QueryPage<{ done: boolean }>> = postgrest.queryWithSignal(query, signal);
const couchPage: Promise<QueryPage<{ done: boolean }>> = couch.queryWithSignal(query, signal);
const nativeQuery: NativeCouchDbQuery<{ done: boolean }> = { ...query, projection: ["_id"] };
const nativePage: Promise<QueryPage<{ done: boolean }>> = nativeCouch.queryWithSignal(nativeQuery, signal);
const nativeConnection: Promise<NativeCouchDbConnectionTest> = nativeCouch.testConnection(signal);
const nativeDescription: Promise<NativeCouchDbDescribe> = nativeCouch.describe(signal);

// The callback parameter must be the modern @dalgo/core type, not a legacy
// @dal-go/dalgo type and not `any`.
const callback: (transaction: ReadwriteTransaction) => Promise<string> = async (transaction) => transaction.constructor.name;
const postTransaction: Promise<string> = postgrest.runReadwriteTransaction(callback);
const couchTransaction: Promise<string> = couch.runReadwriteTransaction(callback);

void postgrestDatabase.get(key("items", "milk"));
void couchDatabase.get(key("items", "milk"));
void postgrestDatabase;
void couchDatabase;
void nativeDatabase;
void nativeStorage;
void postgrestCancellable;
void couchCancellable;
void postPage;
void couchPage;
void nativePage;
void nativeConnection;
void nativeDescription;
void postTransaction;
void couchTransaction;
void PostgrestRequestError;
void CouchDbRequestError;
void POSTGREST_READ_CAPABILITIES;
void COUCHDB_READ_CAPABILITIES;
void NATIVE_COUCHDB_READ_CAPABILITIES;

// Runtime narrowing keeps the same contract after declaration packing.
export const cancellable = {
  postgrest: isCancellableQueryExecutor(postgrest),
  couch: isCancellableQueryExecutor(couch),
};
