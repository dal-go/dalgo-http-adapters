import { Key, type Database, type RecordSnapshot } from "@dalgo/core";
import { QueryCancelledError, type CancellableQueryExecutor } from "@dalgo/adapter-runtime";
import { ConvexDatabase, ConvexReadError, type ConvexNativePage, type ConvexOptions, type ConvexValue } from "@dalgo/dalgo2convex";
// @ts-expect-error Node Buffer must not enter the DOM-only program.
type ForbiddenBuffer = typeof Buffer;
// @ts-expect-error Node process must not enter the DOM-only program.
type ForbiddenProcess = typeof process;
// @ts-expect-error NodeJS namespace must not enter the DOM-only program.
type ForbiddenNamespace = NodeJS.Process;
declare const signal: AbortSignal;
const options: ConvexOptions = {
  endpoint: "https://owned.convex.cloud", token: tokenSignal => { tokenSignal.throwIfAborted(); return "fixture-user-jwt"; },
  collections: { tasks: { getFunction: "dalgo:getTask" } },
  queries: { tasks: { path: "dalgo:listTasks", collection: "tasks" } },
};
const db = new ConvexDatabase(options);
const database: Database = db, cancellable: CancellableQueryExecutor = db;
const one: Promise<RecordSnapshot<{ amount: bigint; bytes: ArrayBuffer }>> = db.getWithSignal<{ amount: bigint; bytes: ArrayBuffer }>(new Key("tasks", "a"), signal);
const many: Promise<readonly RecordSnapshot<{ amount: bigint }>[]> = db.getManyWithSignal<{ amount: bigint }>([new Key("tasks", "a")], signal);
const page: Promise<ConvexNativePage> = db.queryFunction("tasks", {}, { pageSize: 1, signal });
const value: ConvexValue = 9223372036854775807n;
void [database, cancellable, one, many, page, value, QueryCancelledError, ConvexReadError];
