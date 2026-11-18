import { collection, key, type Database, type QueryPage, type RecordSnapshot, type WriteSession } from "@dalgo/core";
import { type CancellableQueryExecutor, QueryCancelledError } from "@dalgo/adapter-runtime";
import { CouchDbDatabase, NativeCouchDbDatabase, CouchDbHttpError, CouchDbRequestError, type CouchDbDatabaseOptions, type NativeCouchDbDatabaseOptions, type NativeCouchDbQuery, type NativeCouchDbDescribe } from "@dalgo/dalgo2couchdb";

declare const signal: AbortSignal;
const managedOptions: CouchDbDatabaseOptions = { databaseUrl: "https://couch.example.test/managed", headers: scope => { scope?.throwIfAborted(); return { authorization: "owned-token" }; }, maxGetManyBytes: 4096 };
const nativeOptions: NativeCouchDbDatabaseOptions = { ...managedOptions, databaseUrl: "https://couch.example.test/native", collection: "items", permittedIndexes: [{ ddoc: "_design/status-id", name: "status-id-index", fields: [{ field: "status", direction: "asc" }, { field: "_id", direction: "asc" }] }] };
const managed = new CouchDbDatabase(managedOptions); const native = new NativeCouchDbDatabase(nativeOptions);
const databases: readonly Database[] = [managed, native]; const cancellable: readonly CancellableQueryExecutor[] = [managed, native]; const writes: WriteSession = managed;
const items = collection<{ status: string; title: string }>("items");
const nativeQuery: NativeCouchDbQuery<{ status: string; title: string }> = { ...items.query().where("status", "==", "open").orderBy("status").limit(1).build(), projection: ["_id", "title"] };
const one: Promise<RecordSnapshot<{ title: string }>> = native.getWithSignal<{ title: string }>(key("items", "a"), signal);
const many: Promise<readonly RecordSnapshot<{ title: string }>[]> = managed.getManyWithSignal<{ title: string }>([key("items", "a")], signal);
const page: Promise<QueryPage<{ status: string; title: string }>> = native.queryWithSignal(nativeQuery, signal);
const describe: Promise<NativeCouchDbDescribe> = native.describe(signal);
const legacy = new CouchDbDatabase({ ...managedOptions, headers: () => ({ authorization: "zero-argument-compatible" }) });
void [databases, cancellable, writes, one, many, page, describe, legacy, QueryCancelledError, CouchDbHttpError, CouchDbRequestError];
const nodeBuffer: Buffer = Buffer.from("Node-only profile");
void nodeBuffer;
