// Separate DOM-only consumer: no Node types, no driver entry imports.
import { collection, key, type Database, type QueryPage, type RecordSnapshot } from "@dalgo/core";
import { type OrdinalQueryExecutor, type OrdinalQueryResult } from "@dalgo/adapter-runtime";
import { RedisHttpExecutor, type RedisReadExecutor, type RedisValue } from "@dalgo/dalgo2redis-resp";
import { MongoDatabase, MongoHttpClient, type MongoReadExecutor } from "@dalgo/dalgo2mongodb";
import { MongoDatabase as BrowserMongoDatabase, MongoHttpClient as BrowserMongoHttpClient } from "@dalgo/dalgo2mongodb/browser";
import { DuckDBError, type OrdinalValue } from "@dalgo/dalgo2duckdb";
import { BrowserDuckDBDatabase, type BrowserDuckDBOptions } from "@dalgo/dalgo2duckdb/browser";

// Expected-error probes fail if any browser declaration pulls in Node ambient
// types, even through an explicit triple-slash type reference in a dependency.
// @ts-expect-error Node Buffer must not enter this DOM-only program.
type ForbiddenBuffer = typeof Buffer;
// @ts-expect-error Node process must not enter this DOM-only program.
type ForbiddenProcess = typeof process;
// @ts-expect-error The NodeJS namespace must not enter this DOM-only program.
type ForbiddenNodeNamespace = NodeJS.Process;
// @ts-expect-error Driver executors belong only to the explicit Node subpath.
import { MongoNodeExecutor } from "@dalgo/dalgo2mongodb/browser";
// @ts-expect-error RESP TCP belongs only to the explicit Node subpath.
import { RedisNodeExecutor } from "@dalgo/dalgo2redis-resp";
// @ts-expect-error DuckDB engines are excluded from its lightweight root.
import { NodeDuckDBDatabase } from "@dalgo/dalgo2duckdb";

declare const signal: AbortSignal;
const resp: RedisReadExecutor = new RedisHttpExecutor({ endpoint: "https://app.example.test/redis" });
const reply: Promise<RedisValue> = resp.execute(["GET", "fixture"], signal);
const http: MongoReadExecutor = new MongoHttpClient({ endpoint: "https://app.example.test/mongo", connectionId: "fixture" });
const mongo = new MongoDatabase(http, { idKind: "string" });
const coreDatabase: Database = mongo;
const constructorAlias: typeof MongoDatabase = BrowserMongoDatabase;
const httpAlias: typeof MongoHttpClient = BrowserMongoHttpClient;
const items = collection<{ done: boolean }>("items");
const page: Promise<QueryPage<{ done: boolean }>> = mongo.queryWithSignal(items.query().limit(1).build(), signal);
const record: Promise<RecordSnapshot<{ done: boolean }>> = mongo.get<{ done: boolean }>(key("items", "fixture"));
const options: BrowserDuckDBOptions = { bundle: { mainModule: "/engine.wasm", mainWorker: "/worker.js" } };
const duck: OrdinalQueryExecutor = new BrowserDuckDBDatabase(options);
const result: Promise<OrdinalQueryResult> = duck.queryOrdinal({ kind: "native", sql: "SELECT 1" }, signal);
const exact: OrdinalValue = { kind: "integer", value: "9007199254740993" };
void [reply, coreDatabase, constructorAlias, httpAlias, page, record, result, exact, DuckDBError,
  MongoNodeExecutor, RedisNodeExecutor, NodeDuckDBDatabase];
