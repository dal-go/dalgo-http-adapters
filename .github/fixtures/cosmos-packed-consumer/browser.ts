import { collection, key, type Database, type QueryPage, type RecordSnapshot } from "@dalgo/core";
import { type CancellableQueryExecutor, QueryCancelledError } from "@dalgo/adapter-runtime";
import { CosmosNoSqlDatabase, CosmosHttpError, CosmosTransportError, type CosmosNoSqlOptions, type CosmosAuthorizationRequest } from "@dal-go/dalgo2cosmosdb";

declare const signal: AbortSignal;
const options: CosmosNoSqlOptions = {
  endpoint: "https://cosmos.example.test", databaseId: "fixture", containerId: "records",
  authorization: (request: CosmosAuthorizationRequest) => { request.signal.throwIfAborted(); return "owned-read-resource-token"; },
  partitionKey: (path) => path,
};
const db = new CosmosNoSqlDatabase(options);
const database: Database = db;
const cancellable: CancellableQueryExecutor = db;
const items = collection<{ title: string; done: boolean }>("items");
const one: Promise<RecordSnapshot<{ title: string }>> = db.getWithSignal<{ title: string }>(key("items", "one"), signal);
const many: Promise<readonly RecordSnapshot<{ title: string }>[]> = db.getManyWithSignal<{ title: string }>([key("items", "one")], signal);
const page: Promise<QueryPage<{ title: string; done: boolean }>> = db.queryWithSignal(items.query().where("done", "==", false).limit(2).build(), signal);
const insert: Promise<void> = db.insert(key("items", "one"), { title: "fixture" });
const set: Promise<void> = db.set(key("items", "one"), { title: "fixture" });
const remove: Promise<void> = db.delete(key("items", "one"));
const compatible = new CosmosNoSqlDatabase({ ...options, authorization: () => "old-zero-argument-provider" });
void [database, cancellable, one, many, page, insert, set, remove, compatible, QueryCancelledError, CosmosHttpError, CosmosTransportError];
// @ts-expect-error Node Buffer must not enter this DOM-only program.
type ForbiddenBuffer = typeof Buffer;
// @ts-expect-error Node process must not enter this DOM-only program.
type ForbiddenProcess = typeof process;
// @ts-expect-error NodeJS namespace must not enter this DOM-only program.
type ForbiddenNamespace = NodeJS.Process;
