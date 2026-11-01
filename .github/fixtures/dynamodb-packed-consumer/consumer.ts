import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { collection, key, type Database, type QueryPage, type RecordSnapshot } from "@dalgo/core";
import { type CancellableQueryExecutor, QueryCancelledError } from "@dalgo/adapter-runtime";
import { DynamoDbDatabase, DynamoDbReadError, type DynamoDbTableOptions, type DynamoDbDocumentClientLike } from "@dal-go/dalgo2dynamodb";

declare const signal: AbortSignal;
const official = DynamoDBDocumentClient.from(new DynamoDBClient({
  region: "us-east-1", credentials: () => Promise.reject(new Error("types-only fixture")),
  requestHandler: { handle: () => Promise.reject(new Error("types-only fixture")) },
}));
const publicClient: DynamoDbDocumentClientLike = official;
const options: DynamoDbTableOptions = { tableName: "owned", timeoutMs: 1000, maxReadRecords: 1000, maxReadBytes: 4000000, maxQueryPages: 100 };
const db = new DynamoDbDatabase(official, options);
const coreDatabase: Database = db;
const cancellable: CancellableQueryExecutor = db;
const items = collection<{ value: string }>("items");
const one: Promise<RecordSnapshot<{ value: string }>> = db.getWithSignal<{ value: string }>(key("items", "one"), signal);
const many: Promise<readonly RecordSnapshot<{ value: string }>[]> = db.getManyWithSignal<{ value: string }>([key("items", "one")], signal);
const page: Promise<QueryPage<{ value: string }>> = db.queryWithSignal(items.query().where("value", "==", "ok").limit(1).build(), signal);
// Preserve the existing mutation surface and official-client constructor typing.
const write: Promise<void> = db.set(items.key("one"), { value: "types-only" });
const nodeBuffer: Buffer = Buffer.from("Node-only profile");
void [publicClient, coreDatabase, cancellable, one, many, page, write, nodeBuffer, QueryCancelledError, DynamoDbReadError];
