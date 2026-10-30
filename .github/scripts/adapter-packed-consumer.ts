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
} from "@dalgo/dalgo2couchdb";
import {
  LIBSQL_READ_CAPABILITIES,
  LibSQLCursorError,
  LibSQLDatabase,
  LibSQLHttpError,
  NATIVE_LIBSQL_READ_CAPABILITIES,
  NativeLibSQLDatabase,
  type LibSQLDatabaseOptions,
  type LibSQLDiscovery,
  type NativeLibSQLDatabaseOptions,
  type NativeLibSQLDescribe,
} from "@dalgo/dalgo2libsql";
import {
  POSTGREST_READ_CAPABILITIES,
  PostgrestDatabase,
  PostgrestRequestError,
  type PostgrestConnectionStatus,
  type PostgrestDatabaseOptions,
  type PostgrestDiscovery,
} from "@dalgo/dalgo2postgrest";
import {
  TYPESENSE_READ_CAPABILITIES,
  TypesenseContinuationBoundError,
  TypesenseDatabase,
  TypesenseJsonNumberError,
  type TypesenseDatabaseOptions,
  type TypesenseNativeSearchResult,
  type TypesenseQuery,
} from "@dalgo/dalgo2typesense";
import {
  ClickHouseDatabase,
  NativeClickHouseDatabase,
  type NativeClickHouseDatabaseOptions,
} from "@dalgo/dalgo2clickhouse";
import {
  isCancellableQueryExecutor,
  type CancellableQueryExecutor,
  isOrdinalQueryExecutor,
  type OrdinalQueryExecutor,
  type OrdinalQueryResult,
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

const clickhouseOptions: NativeClickHouseDatabaseOptions = {
  serverUrl: "https://clickhouse.example.test",
  tables: { items: { database: "explore", table: "items", columns: { id: "id" } } },
};
const clickhouse = new NativeClickHouseDatabase(clickhouseOptions);
const clickhouseAlias: typeof NativeClickHouseDatabase = ClickHouseDatabase;
const clickhouseExecutor: OrdinalQueryExecutor = clickhouse;
const clickhouseResult: Promise<OrdinalQueryResult> = clickhouseExecutor.queryOrdinal({
  kind: "structured",
  query: { source: { kind: "collection", name: "items" }, filters: [], orders: [], limit: 1 },
  columns: [{ expression: { kind: "field", field: { source: "items", field: "id" } }, as: "id" }],
}, signal);
void [clickhouseAlias, clickhouseResult, isOrdinalQueryExecutor(clickhouse)];

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
const libsqlOptions: LibSQLDatabaseOptions = {
  serverUrl: "https://libsql.example.test",
  maxRows: 10,
  tables: {
    items: {
      table: "items",
      uniqueKey: true,
      keyColumn: { column: "id", nullable: false },
      columns: { title: { column: "title", nullable: false } },
    },
  },
};
const nativeLibsqlOptions: NativeLibSQLDatabaseOptions = {
  serverUrl: "https://libsql.example.test",
  identityScope: "consumer",
  maxQueryLimit: 10,
  tables: {
    items: {
      table: "items",
      uniqueKey: true,
      key: { column: "id", type: "integer" },
      columns: { title: { column: "title", nullable: false } },
    },
  },
};
const typesenseOptions: TypesenseDatabaseOptions = {
  baseUrl: "https://typesense.example.test:8108",
  collection: "items",
  headers: () => ({ "X-TYPESENSE-API-KEY": "scoped-readonly-key" }),
  maxQueryLimit: 10,
  maxRowsPerPage: 10,
};
const postgrest = new PostgrestDatabase(postgrestOptions);
const typesense = new TypesenseDatabase(typesenseOptions);
const couch = new CouchDbDatabase(couchOptions);
const nativeCouch = new NativeCouchDbDatabase(nativeOptions);
const libsql = new LibSQLDatabase(libsqlOptions);
const nativeLibsql = new NativeLibSQLDatabase(nativeLibsqlOptions);

// The managed adapters still satisfy the core Database/WriteSession identity.
const postgrestDatabase: Database & WriteSession = postgrest;
const couchDatabase: Database & WriteSession = couch;
const nativeDatabase: Database = nativeCouch;
const libsqlDatabase: Database & WriteSession = libsql;
const nativeLibsqlDatabase: Database = nativeLibsql;
const typesenseDatabase: Database = typesense;
const nativeStorage: "native-rows" = NATIVE_COUCHDB_READ_CAPABILITIES.storage;
const libsqlStorage: "native-rows" = NATIVE_LIBSQL_READ_CAPABILITIES.storage;
const nativeLibsqlStorage: "native-rows" = LIBSQL_READ_CAPABILITIES.storage;

// The additive cancellable surface is assignable to the shared runtime contract.
const postgrestCancellable: CancellableQueryExecutor = postgrest;
const couchCancellable: CancellableQueryExecutor = couch;
const libsqlCancellable: CancellableQueryExecutor = libsql;
const nativeLibsqlCancellable: CancellableQueryExecutor = nativeLibsql;
const typesenseCancellable: CancellableQueryExecutor = typesense;

const items = collection<{ done: boolean }>("items");
const numericItems = collection<{ title: string }, number>("items");
const query: StructuredQuery<{ done: boolean }> = items.query().limit(1).build();
const postPage: Promise<QueryPage<{ done: boolean }>> = postgrest.queryWithSignal(query, signal);
const couchPage: Promise<QueryPage<{ done: boolean }>> = couch.queryWithSignal(query, signal);
const nativeQuery: NativeCouchDbQuery<{ done: boolean }> = { ...query, projection: ["_id"] };
const nativePage: Promise<QueryPage<{ done: boolean }>> = nativeCouch.queryWithSignal(nativeQuery, signal);
const nativeConnection: Promise<NativeCouchDbConnectionTest> = nativeCouch.testConnection(signal);
const nativeDescription: Promise<NativeCouchDbDescribe> = nativeCouch.describe(signal);
const postDiscovery: Promise<PostgrestDiscovery> = postgrest.discover(signal);
const postConnection: Promise<PostgrestConnectionStatus> = postgrest.testConnection(signal);
const libsqlPage: Promise<QueryPage<{ done: boolean }>> = libsql.queryWithSignal(query, signal);
const libsqlDiscovery: Promise<LibSQLDiscovery> = libsql.discover(signal);
const libsqlConnection = libsql.testConnection(signal);
const nativeLibsqlPage: Promise<QueryPage<{ done: boolean }>> = nativeLibsql.queryWithSignal(query, signal);
const nativeLibsqlDiscovery: Promise<LibSQLDiscovery> = nativeLibsql.discover(signal);
const nativeLibsqlConnection = nativeLibsql.testConnection(signal);
const nativeLibsqlDescription: Promise<NativeLibSQLDescribe> = nativeLibsql.describe(signal);
const numericKey: number = numericItems.key(7).id;
const typesenseQuery: TypesenseQuery<{ done: boolean }> = { ...query, projection: ["done"] };
const typesensePage: Promise<QueryPage<{ done: boolean }>> = typesense.queryWithSignal(typesenseQuery, signal);
const typesenseSearch: Promise<TypesenseNativeSearchResult> = typesense.searchWithSignal({
  q: "ordinary full text",
  queryBy: ["title"],
  limit: 1,
}, signal);
const typesenseStorage: "native-rows" = TYPESENSE_READ_CAPABILITIES.storage;

// The callback parameter must be the modern @dalgo/core type, not a legacy
// @dal-go/dalgo type and not `any`.
const callback: (transaction: ReadwriteTransaction) => Promise<string> = async (transaction) => transaction.constructor.name;
const postTransaction: Promise<string> = postgrest.runReadwriteTransaction(callback);
const couchTransaction: Promise<string> = couch.runReadwriteTransaction(callback);
const libsqlTransaction: Promise<string> = libsql.runReadwriteTransaction(callback);
const nativeLibsqlTransaction: Promise<string> = nativeLibsql.runReadwriteTransaction(callback);

void postgrestDatabase.get(key("items", "milk"));
void couchDatabase.get(key("items", "milk"));
void postgrestDatabase;
void couchDatabase;
void nativeDatabase;
void libsqlDatabase;
void nativeLibsqlDatabase;
void nativeStorage;
void libsqlStorage;
void nativeLibsqlStorage;
void postgrestCancellable;
void couchCancellable;
void libsqlCancellable;
void nativeLibsqlCancellable;
void postPage;
void couchPage;
void nativePage;
void nativeConnection;
void nativeDescription;
void postDiscovery;
void postConnection;
void libsqlPage;
void libsqlDiscovery;
void libsqlConnection;
void nativeLibsqlPage;
void nativeLibsqlDiscovery;
void nativeLibsqlConnection;
void nativeLibsqlDescription;
void numericKey;
void postTransaction;
void couchTransaction;
void libsqlTransaction;
void nativeLibsqlTransaction;
void typesenseDatabase;
void typesenseCancellable;
void typesensePage;
void typesenseSearch;
void typesenseStorage;
void TypesenseContinuationBoundError;
void TypesenseJsonNumberError;
void PostgrestRequestError;
void CouchDbRequestError;
void LibSQLHttpError;
void LibSQLCursorError;
void POSTGREST_READ_CAPABILITIES;
void COUCHDB_READ_CAPABILITIES;
void NATIVE_COUCHDB_READ_CAPABILITIES;
void LIBSQL_READ_CAPABILITIES;
void NATIVE_LIBSQL_READ_CAPABILITIES;

// Runtime narrowing keeps the same contract after declaration packing.
export const cancellable = {
  postgrest: isCancellableQueryExecutor(postgrest),
  couch: isCancellableQueryExecutor(couch),
  libsql: isCancellableQueryExecutor(libsql),
  nativeLibsql: isCancellableQueryExecutor(nativeLibsql),
  typesense: isCancellableQueryExecutor(typesense),
};
