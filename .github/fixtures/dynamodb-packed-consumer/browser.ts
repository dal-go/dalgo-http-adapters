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
