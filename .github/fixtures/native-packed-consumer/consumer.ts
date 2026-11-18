// Compiled only against installed tarballs with strict declarations enabled.
import { collection, key, type Database, type QueryPage, type ReadwriteTransaction, type RecordSnapshot } from "@dalgo/core";
import { isOrdinalQueryExecutor, type OrdinalQueryExecutor, type OrdinalQueryResult } from "@dalgo/adapter-runtime";
import { RedisHttpExecutor, type RedisHttpOptions, type RedisReadExecutor, type RedisValue } from "@dalgo/dalgo2redis-resp";
import { RedisNodeExecutor, createRedisHttpHandler, type RedisNodeOptions } from "@dalgo/dalgo2redis-resp/node";
import { MongoDatabase, MongoHttpClient, type MongoReadExecutor, type MongoReadRequest, type MongoReadResult } from "@dalgo/dalgo2mongodb";
import { MongoDatabase as BrowserMongoDatabase, MongoHttpClient as BrowserMongoHttpClient } from "@dalgo/dalgo2mongodb/browser";
import { MongoNodeExecutor, createMongoHttpHandler, type MongoNodeExecutorOptions } from "@dalgo/dalgo2mongodb/node";
import { DuckDBError, type DuckDBLimits, type OrdinalValue } from "@dalgo/dalgo2duckdb";
import { BrowserDuckDBDatabase, type BrowserDuckDBOptions } from "@dalgo/dalgo2duckdb/browser";
import { NodeDuckDBDatabase, type NodeDuckDBOptions } from "@dalgo/dalgo2duckdb/node";

declare const signal: AbortSignal;
declare const mongoNodeOptions: MongoNodeExecutorOptions;
const redisHttpOptions: RedisHttpOptions = { endpoint: "https://app.example.test/redis" };
const redisNodeOptions: RedisNodeOptions = { host: "127.0.0.1", port: 6379, scanPrefix: "tenant:" };
const redisHttp: RedisReadExecutor = new RedisHttpExecutor(redisHttpOptions);
const redisNode: RedisReadExecutor = new RedisNodeExecutor(redisNodeOptions);
const nativeReply: Promise<RedisValue> = redisNode.execute(["GET", "tenant:item"], signal);
const httpReply: Promise<RedisValue> = redisHttp.execute(["PTTL", "tenant:item"], signal);
// @ts-expect-error RESP reads do not advertise the keyed core Database surface.
const redisDatabase: Database = redisNode;

const mongoHttp: MongoReadExecutor = new MongoHttpClient({ endpoint: "https://app.example.test/mongo", connectionId: "fixture" });
const mongoNode: MongoReadExecutor = new MongoNodeExecutor(mongoNodeOptions);
const nativeMongoRequest: MongoReadRequest = { kind: "find", collection: "items", limit: 1 };
const nativeMongoReply: Promise<MongoReadResult> = mongoNode.execute(nativeMongoRequest, signal);
const mongo = new MongoDatabase(mongoHttp, { idKind: "string" });
const coreDatabase: Database = mongo;
const browserConstructor: typeof MongoDatabase = BrowserMongoDatabase;
const browserTransport: typeof MongoHttpClient = BrowserMongoHttpClient;
const items = collection<{ done: boolean }>("items");
const page: Promise<QueryPage<{ done: boolean }>> = mongo.queryWithSignal(items.query().limit(1).build(), signal);
const record: Promise<RecordSnapshot<{ done: boolean }>> = mongo.get<{ done: boolean }>(key("items", "first"));
const callback: (transaction: ReadwriteTransaction) => Promise<string> = async transaction => transaction.constructor.name;
const transaction: Promise<string> = mongo.runReadwriteTransaction(callback);

const limits: DuckDBLimits = { maxRows: 2, maxResultBytes: 1024 };
const nodeOptions: NodeDuckDBOptions = { ...limits, memoryLimitMiB: 64 };
const browserOptions: BrowserDuckDBOptions = { ...limits, bundle: { mainModule: "/engine.wasm", mainWorker: "/worker.js" } };
const duckNode = new NodeDuckDBDatabase(nodeOptions);
const duckBrowser = new BrowserDuckDBDatabase(browserOptions);
const nodeOrdinal: OrdinalQueryExecutor = duckNode;
const browserOrdinal: OrdinalQueryExecutor = duckBrowser;
const ordinalReply: Promise<OrdinalQueryResult> = nodeOrdinal.queryOrdinal({ kind: "native", sql: "SELECT 1" }, signal);
const exactValue: OrdinalValue = { kind: "integer", value: "9007199254740993" };
const readOnly: true = duckBrowser.readOnly;
// @ts-expect-error Anonymous ordinal DuckDB results are not keyed core records.
const duckDatabase: Database = duckNode;

void [redisDatabase, nativeReply, httpReply, nativeMongoReply, coreDatabase, browserConstructor, browserTransport,
  page, record, transaction, browserOrdinal, ordinalReply, exactValue, readOnly, duckDatabase,
  createRedisHttpHandler, createMongoHttpHandler, DuckDBError, isOrdinalQueryExecutor(duckNode)];
