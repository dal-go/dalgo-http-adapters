import { collection, key, type Database, type QueryPage, type RecordSnapshot } from "@dalgo/core";
import { type CancellableQueryExecutor, QueryCancelledError } from "@dalgo/adapter-runtime";
import { InfluxDB3Database, InfluxDB3HttpError, InfluxDB3TransportError, type InfluxDB3DatabaseOptions } from "@dal-go/dalgo2influxdb";
// @ts-expect-error Node Buffer must not enter this DOM-only program.
type ForbiddenBuffer = typeof Buffer;
// @ts-expect-error Node process must not enter this DOM-only program.
type ForbiddenProcess = typeof process;
// @ts-expect-error NodeJS namespace must not enter this DOM-only program.
type ForbiddenNamespace = NodeJS.Process;

declare const signal: AbortSignal;
const options: InfluxDB3DatabaseOptions = {
  database: "fixture", serverUrl: "https://influx.example.test", accessToken: tokenSignal => { tokenSignal?.throwIfAborted(); return "fixture-token"; },
  tables: { items: { table: "items", keyColumn: { column: "id", nullable: false }, columns: { title: { column: "title" }, done: { column: "done", nullable: false }, rank: { column: "rank", nullable: false } } } },
};
const db = new InfluxDB3Database(options);
const database: Database = db;
const cancellable: CancellableQueryExecutor = db;
const items = collection<{ title: string; done: boolean; rank: number }>("items");
const one: Promise<RecordSnapshot<{ title: string }>> = db.getWithSignal<{ title: string }>(key("items", "one"), signal);
const many: Promise<readonly RecordSnapshot<{ title: string }>[]> = db.getManyWithSignal<{ title: string }>([key("items", "one")], signal);
const page: Promise<QueryPage<{ title: string; done: boolean; rank: number }>> = db.queryWithSignal(items.query().where("done", "==", false).orderBy("rank").limit(1).build(), signal);
const append: Promise<void> = db.appendLineProtocolWithSignal(["fixture value=1"], signal, "second");
void [database, cancellable, one, many, page, append, QueryCancelledError, InfluxDB3HttpError, InfluxDB3TransportError];
