import { Key, collection, type Database, type QueryPage, type RecordSnapshot } from "@dalgo/core";
import { QueryCancelledError, type CancellableQueryExecutor } from "@dalgo/adapter-runtime";
import { ConvexDatabase, ConvexReadError, CONVEX_CAPABILITIES, type ConvexOptions, type ConvexNativePage, type ConvexConfiguredMetadata, type ConvexValue } from "@dalgo/dalgo2convex";
import { convexToJson, jsonToConvex } from "convex/values";

declare const signal: AbortSignal;
const options: ConvexOptions = {
  endpoint: "https://owned.convex.cloud", token: tokenSignal => { tokenSignal.throwIfAborted(); return "fixture-user-jwt"; },
  collections: { tasks: { getFunction: "dalgo:getTask", staticArgs: { tenant: "one" }, fields: [{ name: "amount", type: "int64" }] } },
  queries: { tasks: { path: "dalgo:listTasks", collection: "tasks", arguments: ["filter"], staticArgs: { tenant: "one" } } },
};
const db = new ConvexDatabase(options);
const database: Database = db, cancellable: CancellableQueryExecutor = db;
const one: Promise<RecordSnapshot<{ amount: bigint; bytes: ArrayBuffer }>> = db.getWithSignal<{ amount: bigint; bytes: ArrayBuffer }>(new Key("tasks", "a"), signal);
const many: Promise<readonly RecordSnapshot<{ amount: bigint }>[]> = db.getManyWithSignal<{ amount: bigint }>([new Key("tasks", "a")], signal);
const exists: Promise<boolean> = db.exists(new Key("tasks", "a"), signal);
const native: Promise<ConvexNativePage> = db.queryFunction("tasks", { filter: { amount: 9007199254740993n, bytes: new ArrayBuffer(1), score: NaN } }, { pageSize: 1, signal });
const genericRefusal: Promise<QueryPage<{ amount: bigint }>> = db.queryWithSignal(collection<{ amount: bigint }>("tasks").query().limit(1).build(), signal);
const metadata: ConvexConfiguredMetadata = db.metadata();
const value: ConvexValue = jsonToConvex(convexToJson(9007199254740993n));
const nodeBuffer: Buffer = Buffer.from("Node-only type profile");
void [database, cancellable, one, many, exists, native, genericRefusal, metadata, value, nodeBuffer, QueryCancelledError, ConvexReadError, CONVEX_CAPABILITIES];
