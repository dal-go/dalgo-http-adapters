import {
  COUCHDB_READ_CAPABILITIES,
  CouchDbDatabase,
  CouchDbRequestError,
  type CouchDbDatabaseOptions,
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
const postgrest = new PostgrestDatabase(postgrestOptions);
const couch = new CouchDbDatabase(couchOptions);

// Both adapters still satisfy the core Database/WriteSession identity.
const postgrestDatabase: Database & WriteSession = postgrest;
const couchDatabase: Database & WriteSession = couch;

// The additive cancellable surface is assignable to the shared runtime contract.
const postgrestCancellable: CancellableQueryExecutor = postgrest;
const couchCancellable: CancellableQueryExecutor = couch;

const items = collection<{ done: boolean }>("items");
const query: StructuredQuery<{ done: boolean }> = items.query().limit(1).build();
const postPage: Promise<QueryPage<{ done: boolean }>> = postgrest.queryWithSignal(query, signal);
const couchPage: Promise<QueryPage<{ done: boolean }>> = couch.queryWithSignal(query, signal);

// The callback parameter must be the modern @dalgo/core type, not a legacy
// @dal-go/dalgo type and not `any`.
const callback: (transaction: ReadwriteTransaction) => Promise<string> = async (transaction) => transaction.constructor.name;
const postTransaction: Promise<string> = postgrest.runReadwriteTransaction(callback);
const couchTransaction: Promise<string> = couch.runReadwriteTransaction(callback);

void postgrestDatabase.get(key("items", "milk"));
void couchDatabase.get(key("items", "milk"));
void postgrestDatabase;
void couchDatabase;
void postgrestCancellable;
void couchCancellable;
void postPage;
void couchPage;
void postTransaction;
void couchTransaction;
void PostgrestRequestError;
void CouchDbRequestError;
void POSTGREST_READ_CAPABILITIES;
void COUCHDB_READ_CAPABILITIES;

// Runtime narrowing keeps the same contract after declaration packing.
export const cancellable = {
  postgrest: isCancellableQueryExecutor(postgrest),
  couch: isCancellableQueryExecutor(couch),
};
