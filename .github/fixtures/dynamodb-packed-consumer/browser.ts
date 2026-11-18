import { collection, key, type Database, type QueryPage, type RecordSnapshot } from "@dalgo/core";
import { type CancellableQueryExecutor, QueryCancelledError } from "@dalgo/adapter-runtime";
import { DynamoDbDatabase, DynamoDbReadError, type DynamoDbTableOptions, type DynamoDbDocumentClientLike } from "@dal-go/dalgo2dynamodb";
// @ts-expect-error Node Buffer must not leak from the adapter's public declarations.
type ForbiddenBuffer = typeof Buffer;
// @ts-expect-error Node process must not leak from the adapter's public declarations.
type ForbiddenProcess = typeof process;
// @ts-expect-error NodeJS namespace must not leak from the adapter's public declarations.
type ForbiddenNamespace = NodeJS.Process;

declare const signal: AbortSignal;
declare const borrowed: DynamoDbDocumentClientLike;
const options: DynamoDbTableOptions = { tableName: "owned", timeoutMs: 1000, maxReadRecords: 1000, maxReadBytes: 4000000 };
const db = new DynamoDbDatabase(borrowed, options);
const coreDatabase: Database = db;
const cancellable: CancellableQueryExecutor = db;
const items = collection<{ value: string }>("items");
const one: Promise<RecordSnapshot<{ value: string }>> = db.getWithSignal<{ value: string }>(key("items", "one"), signal);
const many: Promise<readonly RecordSnapshot<{ value: string }>[]> = db.getManyWithSignal<{ value: string }>([key("items", "one")], signal);
const page: Promise<QueryPage<{ value: string }>> = db.queryWithSignal(items.query().limit(1).build(), signal);
// @ts-expect-error A send implementation must return a promise.
const invalidClient: DynamoDbDocumentClientLike = { send: () => 1 };
void [coreDatabase, cancellable, one, many, page, invalidClient, QueryCancelledError, DynamoDbReadError];

// Adapter-only DOM native API; no vendor declaration or Node ambient import.
import { NativeDynamoDbDatabase, NativeDynamoDbError, type NativeDynamoDbClientLike, type NativeDynamoDbOptions, type NativeDynamoDbKey, type NativeDynamoDbItem, type NativeDynamoDbValue, type NativeDynamoDbPage, type NativeDynamoDbQuery } from "@dal-go/dalgo2dynamodb";
declare const nativeClient: NativeDynamoDbClientLike;
const nativeOptions: NativeDynamoDbOptions = { tables: { existing: { tableName: "existing", partitionKey: { name: "pk", type: "N" }, sortKey: { name: "sk", type: "B" }, indexes: { byRank: { indexName: "by-rank", kind: "gsi", partitionKey: { name: "group", type: "S" }, sortKey: { name: "rank", type: "N" }, projection: ["payload"] } } } }, timeoutMs: 1000, maxReadBytes: 4000000, maxRecords: 1000, maxPages: 10, maxEvaluated: 100 };
const nativeDb = new NativeDynamoDbDatabase(nativeClient, nativeOptions);
const nativeKey: NativeDynamoDbKey = { pk: { N: "9007199254740993" }, sk: { B: new Uint8Array([0, 255]) } };
const nativeValue: NativeDynamoDbValue = { M: { exact: { N: "123456789012345678901234567890.0001" }, binary: { B: new Uint8Array([0, 255]) }, nested: { L: [{ NULL: true }, { BOOL: false }, { SS: ["x"] }, { NS: ["1.00"] }, { BS: [new Uint8Array([0])] }] } } };
const nativeQuery: NativeDynamoDbQuery = { collection: "existing", index: "byRank", partition: { S: "tenant" }, limit: 1 };
const nativeOne: Promise<NativeDynamoDbItem | null> = nativeDb.getWithSignal("existing", nativeKey, signal);
const nativeMany: Promise<readonly (NativeDynamoDbItem | null)[]> = nativeDb.getManyWithSignal("existing", [nativeKey, nativeKey], signal);
const nativePage: Promise<NativeDynamoDbPage> = nativeDb.queryPartitionWithSignal(nativeQuery, signal);
const nativeTables: Readonly<Record<string, import("@dal-go/dalgo2dynamodb").NativeDynamoDbTable>> = nativeDb.configuredTables();
nativeDb.close();
void [nativeValue, nativeOne, nativeMany, nativePage, nativeTables, NativeDynamoDbError];
